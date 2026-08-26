/**
 * `sapui5-validate generate` orchestrator (SPEC §2.1, §2.3, §2.4, §2.10).
 *
 * Flow:
 *   detect → ts-guard → git-clean → tooling probe →
 *   baseline-clean GUARD (§2.3 — generate refuses on a red baseline; unlike
 *   validate, no LLM-bootstrap fix loop) → no-tests handling (§2.4: TTY
 *   prompt + template scaffold, --json/non-TTY hard fail) → file-scope →
 *   discover candidates → per-candidate generate-and-verify with 3 retries
 *   and `_failing/` quarantine on the 3rd failure.
 *
 * Every external boundary (git, exec, claude binary, verify pipeline, fs
 * probe, the TTY template picker) is injectable so the integration test can
 * drive the full orchestrator headlessly with deterministic stubs.
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AuditLog } from '../audit/log.js';
import { checkUnpreloadedLibs } from '../checks/unpreloaded-libs.js';
import { buildProjectGraph } from '../project/dependency-graph.js';
import { AuditingRunner, wrapVerifyFnWithAudit } from '../audit/runner.js';
import { collectBaselineFindings, makeBaselineLintProbe } from './baseline.js';
import {
  CallBudget,
  DEFAULT_LLM_BUDGET,
  BudgetExhaustedError,
  type Sleeper,
} from '../claude/budget.js';
import { estimateCallsForGenerate } from '../budget/estimator.js';
import { promptCallLimitChoice, promptModelChoice, type MenuIo } from '../budget/menu.js';
import { ClaudeEnvelopeContractError, RateLimitExhaustedError } from '../claude/binary-runner.js';
import { claudeVersionWarning, type ClaudeAvailability } from '../claude/availability.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { RunUsageAccumulator, formatUsageSummaryLine } from '../claude/usage.js';
import {
  detectSapUi5Project,
  hasProjectTypeScript,
  hasTsAwareEslintConfig,
} from '../project/detect.js';
import type { ProjectLanguage } from '../project/detect.js';
import { GitNoRepositoryError, isWorkingTreeClean, type GitClient } from '../project/git.js';
import { detectSinonDialect } from '../project/sinon-dialect.js';
import { detectTestLayout } from '../project/test-layout.js';
import {
  defaultProbeAdapter,
  probeTooling,
  withNpxFallback,
  type ProbeAdapter,
} from '../project/tooling.js';
import { checkTsGuard } from '../project/ts-guard.js';
import { ensureValidatorDirIgnored, ensureSelfScopedIgnore } from '../util/gitignore.js';
import { assertInsideProject, OutsideProjectRootError } from '../util/containment.js';
import { parseJsonWithBom } from '../util/json-read.js';
import { loadTsconfigScope } from '../util/tsconfig-scope.js';
import { createEmptyReport, writeReport } from '../output/report.js';
import { formatPhaseProgress } from '../output/human.js';
import type {
  ExitReason,
  ReportFileEntry,
  ReportGeneratedTest,
  RunReport,
} from '../types.js';
import {
  findQunitCandidates,
  generateQunitTest,
  type QunitCandidate,
} from '../generation/qunit.js';
import {
  findOpa5Candidates,
  generateOpa5Journey,
  type Opa5Candidate,
} from '../generation/opa5.js';
import { detectDiscoveryMode } from '../generation/registration.js';
import {
  getTerminalQuarantineInfo,
  type GenerateOutcome,
} from '../generation/retry-loop.js';
import { Semaphore } from '../util/concurrency.js';
import { RateLimitSignal } from '../claude/rate-limit-signal.js';
import {
  scaffoldTestLayout,
  TEMPLATE_CHOICES,
  type TemplateChoice,
} from '../generation/templates/index.js';
import {
  verifyArtifact,
  type VerifyAdapters,
  type VerifyPipelineInput,
  type VerifyResult,
} from '../verify/pipeline.js';
import {
  classifyKarmaFailure,
  KARMA_TIMEOUT_MS,
  runKarma,
  type KarmaResult,
} from '../verify/karma.js';
import type { ExecImpl } from '../util/exec.js';
import { ExcludedPathScopeError, resolveFileScope } from './validate.js';

export interface GenerateOptions {
  readonly projectRoot: string;
  readonly path?: string;
  readonly all?: boolean;
  readonly base?: string;
  readonly verbose?: boolean;
  readonly maxLlmCalls?: number;
  /**
   * V1.9.4 PERF-17 — explicit per-run model id (`--model <name>`). Free-form;
   * forwarded verbatim to every generate `claude -p` call via `buildClaudeArgs`.
   * When set it WINS and the opt-in model menu is skipped; when unset the menu
   * may set a model on a TTY large run, and absent that the binary picks the
   * default (no `--model` emitted). `src/` pins no id.
   */
  readonly model?: string;
  /**
   * V1.6 — opt-in per-candidate worker-pool degree (`--concurrency N`). Default
   * 1 keeps the SPEC §2.15 "sequential in V1" contract byte-identical. When
   * `>1`, up to N candidates run their `claude -p` generation concurrently while
   * a single run-wide verify lane serialises the register→verify→accept step.
   * Concurrency is honoured only in lane-safe discovery modes
   * (`testsuite-require` / `karma-files-glob`); a `glob-auto`/`unknown` project
   * falls back to serial (see SPEC §2.15). Realising the speed-up against a
   * real project should be blessed by a `test:e2e-real` run at the chosen N
   * before raising the default.
   */
  readonly concurrency?: number;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly keepHistory?: boolean;
  readonly qunitOnly?: boolean;
  readonly opa5Only?: boolean;
  /**
   * V1.4-4 (AP3) — when true, the deterministic manifest.json fix for
   * `baseline-unpreloaded-libs` findings is applied automatically before the
   * generate loop runs. Default off — mirrors `--force` (clean-tree bypass)
   * and `--all` (scope override) as an explicit opt-in flag for behaviours
   * that mutate user-owned config files beyond the default verify-and-report.
   * Without it, affected controllers are skipped (status: 'skipped-baseline').
   */
  readonly autoApplyBaselineFixes?: boolean;
  /** Whether the run can interactively prompt the user (SPEC §2.4). */
  readonly interactive?: boolean;
  /**
   * V1.3.1-5 — when true, skip the interactive call-limit menu entirely and
   * keep the current `--max-llm-calls` budget. Mirrors `validate`'s
   * `noPrompt`: the CI/automation opt-out, distinct from the implicit non-TTY
   * fallback inside `promptCallLimitChoice`.
   */
  readonly noPrompt?: boolean;
  /**
   * V1.3.1-5 — IO override for the interactive call-limit menu. Tests pass a
   * paired Readable + memory Writable; production wiring lets the menu default
   * to `process.stdin`/`stdout`/`stderr`. Mirrors `validate`'s `menuIo`.
   */
  readonly menuIo?: MenuIo;
  /** Injection points (production callers leave these unset). */
  readonly runner: ClaudeRunner;
  readonly gitImpl?: GitClient;
  readonly probeAdapter?: ProbeAdapter;
  readonly verifyAdapters?: VerifyAdapters;
  readonly verifyFn?: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  /**
   * V1.4-10 — injectable CDN-availability probe threaded into
   * `buildProjectGraph` so the unpreloaded-libs check can tell a
   * manifest-fixable gap (lib served by the karma ui5.url CDN) apart from
   * a stub-only gap (lib 404s there). Production leaves it unset: the
   * builder probes the configured CDN via `probeLibServed`. Tests inject a
   * deterministic fake so the suite stays offline.
   */
  readonly probeLib?: (lib: string) => Promise<boolean>;
  /**
   * V1.3.1-3 — injects the exec impl behind the batched baseline-lint path
   * (`runBaselineLint`). Production callers leave it unset (the real `exec` is
   * used); the witness-A integration test supplies a counting stub to assert
   * the baseline guard lints in O(1) subprocesses.
   */
  readonly baselineLintExecImpl?: ExecImpl;
  readonly templatePicker?: TemplatePicker;
  /** SPEC §2.12 startup probe. See validate's docs. */
  readonly availabilityProbe?: () => Promise<ClaudeAvailability>;
  readonly signal?: AbortSignal;
  /**
   * COR-13c / V1.9.3 (D2) — injectable backoff sleeper for the per-call
   * rate-limit retry schedule (SPEC §2.12), threaded onto the QUnit generate
   * path's {@link GenerateContext}. Production leaves it unset → the real
   * `defaultSleeper` (1s / 4s / 16s waits). The D2 integration witness injects
   * an instant sleeper so a non-envelope-429 candidate drives the backoff
   * schedule to its terminal `rate-limited` exit deterministically, without the
   * real wall-clock delays. Unset is byte-identical to the prior path.
   */
  readonly backoffSleeper?: Sleeper;
  /**
   * V1.3.1-4 — destination for human progress output: the quiet-mode baseline
   * status lines and the `--verbose` per-phase lines. Defaults to
   * `process.stderr` (mirrors `validate`'s `warningStream`). Progress never
   * goes to stdout — under `--json` stdout carries only the report JSON.
   * Production callers leave it unset; the integration test injects an
   * in-memory writable to assert against.
   */
  readonly outputStream?: NodeJS.WritableStream;
}

export interface GenerateRunResult {
  readonly report: RunReport;
  readonly exitCode: number;
  readonly reportPath?: string;
}

export type TemplatePicker = (args: {
  readonly namespace: string;
  readonly choices: readonly TemplateChoice[];
}) => Promise<TemplateChoice | null>;

export async function runGenerate(options: GenerateOptions): Promise<GenerateRunResult> {
  const startedAt = new Date();
  // V1.3.1-5: budget is mutable — the interactive call-limit menu (after
  // candidate discovery, before the generator loop) may replace it with a
  // user-chosen limit. Until then it holds the CLI's `--max-llm-calls` value
  // (or the SPEC §2.12 default). Mirrors `validate`'s `let budget`.
  let budget = new CallBudget({ maxCalls: options.maxLlmCalls ?? DEFAULT_LLM_BUDGET });
  // V1.9.4 PERF-17 — resolved per-run model. Starts at the explicit `--model`
  // value (often unset); the opt-in model menu (large-run TTY moment, below) may
  // set it when `--model` was not supplied. Unset → no `--model` emitted (binary
  // picks the default). `finish` records a non-default choice on `report.model`.
  let model: string | undefined = options.model;
  const report = createEmptyReport('generate', startedAt, budget.maxCalls);
  const audit = new AuditLog({
    projectRoot: options.projectRoot,
    keepHistory: options.keepHistory === true,
    startedAt,
  });
  // V1.9.4 PERF-1 — the single run-level usage sink, fed by the AuditingRunner
  // decorator (the choke point every production call already flows through).
  const usage = new RunUsageAccumulator();
  const runner: ClaudeRunner = new AuditingRunner(options.runner, audit, (r) => usage.add(r));

  // V1.3.1-4 — human progress output. Resolved once; defaults to stderr so a
  // `--json` run's stdout carries only the report JSON. `progress` emits the
  // quiet-mode (default) baseline status lines; `progressPhase` emits the
  // additive `--verbose` per-phase lines. Both are hard-gated on
  // `json !== true` — under `--json` nothing progress-related is written.
  const outputStream = options.outputStream ?? process.stderr;
  const progress = (line: string): void => {
    if (options.json === true) return;
    outputStream.write(`${line}\n`);
  };
  const progressPhase = (
    phase: string,
    message: string,
    durationMs?: number,
  ): void => {
    if (options.json === true || options.verbose !== true) return;
    outputStream.write(
      `${formatPhaseProgress(
        durationMs !== undefined
          ? { phase, message, durationMs }
          : { phase, message },
      )}\n`,
    );
  };

  const finish = async (overrides?: Partial<RunReport>): Promise<GenerateRunResult> => {
    const finishedAt = new Date();
    const merged: RunReport = {
      ...report,
      ...(overrides ?? {}),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      llmCallCount: budget.callsUsed,
      llmCallBudget: budget.maxCalls,
      // V1.9.4 PERF-1 — additive-optional summed usage/cost. Absent on
      // LLM-free runs (early-exit paths); `schemaVersion` stays 2.
      ...usage.toReportFields(),
      // V1.9.4 PERF-17 — record the non-default model the run used (absent when
      // the Claude Code default was used). Additive optional; `schemaVersion`
      // stays 2.
      ...(model !== undefined ? { model } : {}),
    };
    let reportPath: string | undefined;
    try {
      await audit.init();
      reportPath = await writeReport(options.projectRoot, merged);
    } catch {
      // Surface report-write failures via the in-memory result only.
    }
    // V1.9.4 PERF-1 — one presence-gated cost/token summary line to the human
    // stream (stderr), suppressed under --json (report.json carries the fields)
    // and on LLM-free runs (formatUsageSummaryLine returns undefined).
    if (options.json !== true) {
      const usageLine = formatUsageSummaryLine(merged);
      if (usageLine !== undefined) {
        outputStream.write(`${usageLine}\n`);
      }
    }
    return reportPath !== undefined
      ? { report: merged, exitCode: merged.exitCode, reportPath }
      : { report: merged, exitCode: merged.exitCode };
  };

  // 0. Claude binary probe (SPEC §2.12). See validate for rationale.
  if (options.availabilityProbe !== undefined) {
    const availability = await options.availabilityProbe();
    if (!availability.ok) {
      return finish({ exitReason: { kind: 'missing-claude' }, exitCode: 1 });
    }
    // TR-2 (V1.9.6): mirror validate — record the CLI version (report.json +
    // audit trail) so an envelope drift is attributable, and WARN (never
    // hard-fail) when it is outside the tested range. Audit stamp best-effort;
    // the warning goes to stderr (`outputStream`), never the --json stdout.
    report.claudeVersion = availability.version;
    try {
      await audit.writeClaudeVersion(availability.version);
    } catch {
      // best-effort — same policy as the AuditingRunner transcript writes.
    }
    const versionWarning = claudeVersionWarning(availability.version);
    if (versionWarning !== null) {
      outputStream.write(`${versionWarning}\n`);
    }
  }

  // 1. Project detection (SPEC §2.2)
  const detection = detectSapUi5Project(options.projectRoot);
  if (!detection.ok) {
    return finish({
      exitReason: { kind: 'not-sapui5-project', path: options.projectRoot },
      exitCode: 1,
    });
  }

  // 2. TypeScript guard (SPEC §2.5). V1.9.2: `generate` now PROCEEDS for TS via
  //    the static-only verify lane (ui5lint + tsc --noEmit + config-gated
  //    eslint, NEVER karma — the never-build firewall). QUnit-only this cycle
  //    (OPA5-for-TS deferred). The `if (!tsGuard.ok)` block stays for the type
  //    narrowing and as a defensive floor; `checkTsGuard` no longer refuses TS.
  const tsGuard = await checkTsGuard(options.projectRoot, { command: 'generate' });
  if (!tsGuard.ok) {
    return finish({ exitReason: { kind: 'typescript-project' }, exitCode: 1 });
  }
  const projectLanguage: ProjectLanguage = tsGuard.language;

  // 3. Clean-tree gate (SPEC §2.6)
  if (options.force !== true) {
    const cleanOpts = options.gitImpl !== undefined ? { gitImpl: options.gitImpl } : {};
    try {
      const clean = await isWorkingTreeClean(options.projectRoot, cleanOpts);
      if (!clean.clean) {
        return finish({ exitReason: { kind: 'dirty-tree' }, exitCode: 1 });
      }
    } catch (err) {
      // COR-1 (§2.6): treat ONLY "no git repository" as proceed (--force exists
      // for explicit overrides). Any other git failure fails closed — see the
      // matching note in validate.ts; generate writes test files, so running on
      // an un-snapshotted tree is exactly what the gate must prevent.
      if (!(err instanceof GitNoRepositoryError)) {
        return finish({
          exitReason: {
            kind: 'error',
            message:
              `Could not determine the git working-tree state ` +
              `(${err instanceof Error ? err.message : String(err)}). ` +
              `The clean-tree safety check (SPEC §2.6) could not run; re-run with ` +
              `--force to bypass it once you have confirmed the tree is safe.`,
          },
          exitCode: 1,
        });
      }
    }
  }

  // SPEC §2.18: best-effort `.gitignore` auto-amend.
  try {
    await ensureValidatorDirIgnored(options.projectRoot);
  } catch {
    // ignore
  }

  // v0.8.1 V3: self-scoped `.sapui5-validator/.gitignore` — same contract as
  // `validate` (see commands/validate.ts): escape of the validator dir
  // itself aborts loudly; any other failure warns, never silent.
  try {
    await ensureSelfScopedIgnore(options.projectRoot);
  } catch (err) {
    if (err instanceof OutsideProjectRootError) throw err;
    outputStream.write(
      `warning: could not write the self-scoped .gitignore for the audit trail ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `.sapui5-validator/ may be git-trackable on this project.\n`,
    );
  }

  // 4. Tooling probe (SPEC §2.11)
  const probe = await probeTooling(options.projectRoot, {
    adapter: options.probeAdapter ?? withNpxFallback(defaultProbeAdapter),
    // V1.9.2 — karma is NOT required for a TS project (the static-only lane
    // never runs it); mirror `validate.ts` so a karma-less TS project is not
    // hard-failed for a tool it never uses. `'js'` keeps karma required.
    projectLanguage,
  });
  if (probe.hardFail) {
    return finish({
      exitReason: { kind: 'missing-required-tooling', tools: probe.missingRequired },
      exitCode: 1,
    });
  }
  const eslintToolOk = probe.tools.find((t) => t.name === 'eslint')?.status === 'ok';
  // V1.9.2 (mirror validate.ts) — on a TS project eslint participates ONLY when
  // the project ships a TS-aware eslint config (else a stock JS flat config
  // parse-errors on `.ts`; ui5lint covers it). JS is byte-identical
  // (`tsEslintAware` is true).
  const tsEslintAware =
    projectLanguage === 'ts' ? hasTsAwareEslintConfig(options.projectRoot) : true;
  const eslintEnabled = eslintToolOk && tsEslintAware;
  // V1.9.2 — run `tsc --noEmit` on the TS verify lane only when the project
  // ships its own `tsc` (the CLI bundles no `typescript`). JS never runs tsc.
  const tscEnabled = projectLanguage === 'ts' && hasProjectTypeScript(options.projectRoot);
  const verifyFn = wrapVerifyFnWithAudit(
    options.verifyFn ?? makeVerifyFn(options.verifyAdapters),
    audit,
  );

  // 5. File scope
  const layout = detectTestLayout(options.projectRoot);
  let scope: Awaited<ReturnType<typeof resolveFileScope>>;
  try {
    scope = await resolveFileScope({
      projectRoot: options.projectRoot,
      all: options.all === true,
      // V1.9.2 (TG-DISC) — gate discovery on the source language so a TS project
      // enumerates `.ts` controllers (and `.qunit.ts` tests); `'js'` is the
      // byte-identical legacy path (mirror validate.ts:403-410).
      projectLanguage,
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.base !== undefined ? { base: options.base } : {}),
      ...(options.gitImpl !== undefined ? { gitImpl: options.gitImpl } : {}),
    });
  } catch (err) {
    if (err instanceof ExcludedPathScopeError) {
      return finish({
        exitReason: { kind: 'error', message: err.message },
        exitCode: 1,
      });
    }
    throw err;
  }

  // 6. Baseline-clean GUARD (SPEC §2.3). Generate refuses on any baseline
  //    failure — broken production code produces broken tests.
  //
  //    V1.3-6: the karma probe is UNCONDITIONAL. It runs the project's
  //    existing suite on every invocation — regardless of file scope —
  //    before candidate discovery and before any LLM call, so a red suite
  //    or a dead karma runner is refused fail-fast with `report.llmCallCount`
  //    at 0. The probe calls the karma adapter directly rather than through
  //    `verifyFn`: `verifyArtifact` runs ui5lint first and skips karma
  //    entirely when no test file is in scope (pipeline.ts), so a
  //    single-controller run has nothing to point a pipeline probe at and a
  //    ui5lint short-circuit would silently skip karma. `runKarma` runs the
  //    whole configured suite regardless of `testFiles`, so a direct call
  //    probes the existing suite even when `scope.qunitTest` is empty. The
  //    trade-off: a direct call bypasses `wrapVerifyFnWithAudit`, so the
  //    probe writes its own karma dump to `last-run/verify/` below.
  //    `validate` keeps its conditional probe — the asymmetry is deliberate
  //    (validate funnels baseline failures into its LLM fix loop; generate
  //    refuses outright). See the V1.3-6 commit's behavior-boundary note.
  const baselineFiles = [
    ...scope.controllerJs,
    ...scope.viewXml,
    ...scope.qunitTest,
  ];
  const karmaProbe = async (): Promise<{
    readonly ok: boolean;
    readonly stderr: string;
    readonly runnerUnavailable?: boolean;
  }> => {
    // Production leaves `verifyAdapters` unset → the real `runKarma`.
    // Integration tests inject a karma stub through `verifyAdapters`.
    const karmaImpl = options.verifyAdapters?.karma ?? runKarma;
    // V1.3.1-4: the karma probe's cold start — a UI5-CDN download plus a
    // headless-Chrome boot — is the slowest part of the baseline guard.
    // Announce it (quiet mode, every mode) so a multi-second wait is not
    // mistaken for a hang; time it under `--verbose`.
    progress('Running existing test suite (karma) — this can take a minute…');
    const karmaStartedAt = Date.now();
    let km: KarmaResult;
    try {
      km = await karmaImpl({
        projectRoot: options.projectRoot,
        testFiles: scope.qunitTest,
        // V1.3.1-3 Problem 3: bound the probe so a hung runner fails fast.
        timeoutMs: KARMA_TIMEOUT_MS,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (err) {
      // COR-13a (§2.1): the karma adapter THREW (vs. returning a non-zero
      // exit) — karma could not run at all. Without this the throw escaped past
      // `finish()`, stripping the report; validate's post-fix gate is already
      // defended this way. Treat it as runner-unavailable so the run finishes
      // with the `karma-unavailable` exit reason and a real report.
      progressPhase('baseline karma', 'done', Date.now() - karmaStartedAt);
      return {
        ok: false,
        stderr: err instanceof Error ? err.message : String(err),
        runnerUnavailable: true,
      };
    }
    progressPhase('baseline karma', 'done', Date.now() - karmaStartedAt);
    // Land the karma output where the `karma-unavailable` / `baseline-failed`
    // messages tell the user to look, matching the retry-loop karma path
    // (which is audited via `wrapVerifyFnWithAudit`).
    try {
      await audit.writeVerify('baseline-karma-probe', 'karma', formatKarmaProbeAudit(km));
    } catch {
      // Audit is best-effort — a log-write failure must not mask the probe.
    }
    if (km.ok) return { ok: true, stderr: '' };
    return {
      ok: false,
      stderr: [km.stderr, km.stdout].filter((s) => s.length > 0).join('\n'),
      runnerUnavailable: classifyKarmaFailure(km) === 'runner-unavailable',
    };
  };
  // V1.3.1-3: the baseline lint pass is batched (O(1) lint subprocesses, see
  // `runBaselineLint`). When an integration test injects verify stubs
  // (`verifyAdapters` / `verifyFn`) the per-file verify pipeline drives the
  // baseline instead, so those tests are unaffected; production uses the
  // batched path. `baselineLintExecImpl` is the witness-A seam onto the
  // batched exec and takes precedence over the per-file fallback.
  const baselineTestMode =
    options.verifyFn !== undefined || options.verifyAdapters !== undefined;
  const baselineLintProbe = makeBaselineLintProbe({
    projectRoot: options.projectRoot,
    files: baselineFiles,
    eslintEnabled,
    // V1.9.2 — widen the batched baseline eslint scope to `.ts` on a TS project.
    ...(projectLanguage === 'ts' ? { tsEslint: true } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.baselineLintExecImpl !== undefined
      ? { batchedExecImpl: options.baselineLintExecImpl }
      : {}),
    ...(baselineTestMode ? { perFileVerifyFn: verifyFn } : {}),
  });
  // V1.3.1-4: wrap the resolved probe so `--verbose` brackets the batched lint
  // with a start/done phase line. The wrapper is transparent — it returns the
  // probe's `BaselineLintResult` unchanged and adds no lint subprocesses.
  const lintProbe = async (): ReturnType<typeof baselineLintProbe> => {
    const fileCount = baselineFiles.length;
    progressPhase(
      'baseline lint',
      `linting ${fileCount} in-scope file${fileCount === 1 ? '' : 's'}…`,
    );
    const lintStartedAt = Date.now();
    const result = await baselineLintProbe();
    progressPhase('baseline lint', 'done', Date.now() - lintStartedAt);
    return result;
  };
  progress('Checking project baseline (lint + existing tests)…');
  // V1.9.2 (TG-FW-BASELINE) — the unconditional whole-suite karma probe is the
  // never-build firewall's other half: it must NEVER run on a TS project (it
  // would karma-run the project's `.ts` sources → in-process Babel = arbitrary
  // code execution). A TS baseline is lint-only; JS passes `karmaProbe` as before.
  const baseline = await collectBaselineFindings({
    lintProbe,
    ...(projectLanguage !== 'ts' ? { karmaProbe } : {}),
  });
  // V1.3-6: a karma runner that could not start is a terminal abort and
  // takes precedence over a co-occurring lint finding — the user cannot
  // trust any verification while the runner is dead. Routed to the
  // dedicated `karma-unavailable` exit reason (V1.3-5). A genuinely red
  // suite or a per-file lint finding still routes to `baseline-failed`.
  if (
    baseline.unattributable.some(
      (u) => u.step === 'karma' && u.runnerUnavailable === true,
    )
  ) {
    return finish({ exitReason: { kind: 'karma-unavailable' }, exitCode: 1 });
  }
  if (baseline.findings.length > 0 || baseline.unattributable.length > 0) {
    return finish({ exitReason: { kind: 'baseline-failed' }, exitCode: 1 });
  }

  // 6b. V1.4-4 — proactive `baseline-unpreloaded-libs` check (deterministic,
  //     no LLM). Build the project graph once at the start of the baseline
  //     phase, run the check, and either auto-apply the manifest fix (when
  //     `--auto-apply-baseline-fixes` is set) or skip the affected
  //     controllers in the generate loop below (the pre-flight skip path).
  //     See `src/checks/unpreloaded-libs.ts` for the deterministic fix
  //     shape and V1.4-PLAN §V1.4-4 for the wiring rationale.
  let projectGraph = await buildProjectGraph({
    projectRoot: options.projectRoot,
    testLayout: layout,
    ...(options.probeLib !== undefined ? { probeLib: options.probeLib } : {}),
  });
  const skippedControllerRels = new Set<string>();
  if (projectGraph.unpreloadedLibs.length > 0) {
    const checkResult = checkUnpreloadedLibs({
      projectRoot: options.projectRoot,
      projectGraph,
    });
    const manifestEntry: ReportFileEntry = {
      file: 'webapp/manifest.json',
      findings: [...checkResult.findings],
      appliedFixes: [],
      revertedFixes: [],
    };
    const fixable = checkResult.findings.find(
      (f) => f.proposedFix !== null,
    );
    if (options.autoApplyBaselineFixes === true && fixable !== undefined) {
      // The combined patch is identical across findings (every finding
      // carries the same `proposedFix.newFileContent` produced by
      // `buildPatchedManifest` over the union of gap libs). One write
      // covers all gaps.
      if (fixable.proposedFix !== null) {
        const manifestAbs = join(options.projectRoot, 'webapp', 'manifest.json');
        // v0.8.1 V1: `webapp/` itself can be a link out of the tree — same
        // realpath assert as every other write site.
        await assertInsideProject(manifestAbs, options.projectRoot);
        await writeFile(manifestAbs, fixable.proposedFix.newFileContent, 'utf8');
        for (const f of checkResult.findings) {
          if (f.proposedFix !== null) {
            manifestEntry.appliedFixes.push({
              checkId: 'baseline-unpreloaded-libs',
              source: 'baseline',
            });
          }
        }
        // V1.4-5 (V1.4-7 criterion (c)) — rebuild the graph after the
        // manifest patch so the in-memory `unpreloadedLibs` reflects
        // disk. Without this, prompts in the generate loop would
        // append a stale project-context block claiming gaps that the
        // manifest now declares — misleading to the LLM and breaking
        // the prompt-block ABSENT-after-fix witness.
        projectGraph = await buildProjectGraph({
          projectRoot: options.projectRoot,
          testLayout: layout,
          ...(options.probeLib !== undefined ? { probeLib: options.probeLib } : {}),
        });
        // R2.4 (AUDIT §5.5) — a gap the check REFUSED to auto-apply
        // (heuristic-derived namespace, no CDN probe) survives the rebuild:
        // its lib was never written to the manifest. Give its controllers
        // the same pre-flight skip as the no-flag path below — generating
        // against a known module-load gap would only quarantine them.
        for (const gap of projectGraph.unpreloadedLibs) {
          if (!gap.cdnServed) continue;
          for (const rel of gap.importedBy) {
            skippedControllerRels.add(rel);
          }
        }
      }
    } else {
      // Pre-flight skip path: mark affected controllers so the generate
      // loop emits `status: 'skipped-baseline'` entries for them.
      //
      // V1.4-10 — only CDN-served (manifest-fixable) gaps cause a skip:
      // their fix is a manifest declaration the user can apply with
      // --auto-apply-baseline-fixes. A stub-only gap (lib 404s on the
      // karma CDN) is NOT skipped — the manifest fix would not help, so we
      // let the generate loop run and the prompt-context block steer the
      // LLM to pre-register a stub for the unloadable module.
      for (const gap of projectGraph.unpreloadedLibs) {
        if (!gap.cdnServed) continue;
        for (const rel of gap.importedBy) {
          skippedControllerRels.add(rel);
        }
      }
    }
    report.files.push(manifestEntry);
  }

  // 7. No-tests handling (SPEC §2.4)
  const namespace = readNamespace(options.projectRoot);
  if (!existsSync(join(options.projectRoot, 'webapp', 'test'))) {
    // V1.9.2 (TG-SCAFFOLD-DEFER, decision #4) — generate-TS requires an existing
    // test layout. `scaffoldTestLayout` writes `.js`/AMD QUnit templates, which
    // would corrupt an ES-module TypeScript project; `.ts` scaffold templates are
    // deferred to a later cycle. Refuse here — BEFORE the template picker / any
    // scaffold write — so a TS project is never seeded with the wrong shape.
    if (projectLanguage === 'ts') {
      outputStream.write(
        'sapui5-validate: generate for a TypeScript project requires an existing ' +
          'webapp/test/ layout; .ts test scaffolding is deferred to a later cycle. ' +
          'Create a webapp/test/unit suite, then re-run.\n',
      );
      return finish({ exitReason: { kind: 'no-tests-template-required' }, exitCode: 1 });
    }
    const canPrompt = options.interactive === true && options.json !== true;
    if (!canPrompt) {
      return finish({ exitReason: { kind: 'no-tests-template-required' }, exitCode: 1 });
    }
    const picker = options.templatePicker ?? defaultTemplatePicker;
    let choice: TemplateChoice | null;
    try {
      choice = await picker({ namespace, choices: TEMPLATE_CHOICES });
    } catch {
      return finish({ exitReason: { kind: 'no-tests-template-required' }, exitCode: 1 });
    }
    if (choice === null) {
      return finish({ exitReason: { kind: 'no-tests-template-required' }, exitCode: 1 });
    }
    await scaffoldTestLayout({ projectRoot: options.projectRoot, namespace, choice });
  }

  // 8. Discover candidates and run generators.
  //
  // V1.3-4 decision 3 — `generate` is QUnit-only by default. OPA5 journeys are
  // produced only under explicit `--opa5-only` and are NOT auto-registered
  // (OPA5 journey registration is out of V1 scope — SPEC §2.1). A plain
  // `generate` and a `--qunit-only` run are therefore both QUnit-only.
  const wantQunit = options.opa5Only !== true;
  // V1.9.2 (TG-OPA5-DEFER) — generate-TS is QUnit-only; OPA5-for-TS is deferred
  // (`findOpa5Candidates` is JS-only and a static-only journey proves ~nothing).
  const wantOpa5 = options.opa5Only === true && projectLanguage !== 'ts';
  // Resolve the test-discovery mode once and thread it into every QUnit
  // generator so generated tests are registered with the project's karma
  // suite before the verify step (SPEC §1.2).
  const discoveryMode = detectDiscoveryMode(options.projectRoot);
  // V1.3.2-4 (Bug B) — resolve the project's sinon dialect once. Threaded
  // into every QUnit prompt builder so the LLM gets a `sap-bundled` reminder
  // when the runtime is the karma-ui5-bundled sinon 1.17 (initial AND
  // refinement prompts, AH4). Surfaced in the stderr banner below and on
  // `report.sinonDialect` (AM5) so a misclassification can be diagnosed
  // without reading source. Absent on early-return paths above (ts-guard,
  // git-clean, missing-claude, baseline-failed) — detection happens AFTER
  // those gates fire, by design.
  const sinonDialect = detectSinonDialect(options.projectRoot, layout);
  report.sinonDialect = sinonDialect;
  // V1.6 / V1.9.7 (THR-1) — resolve the bounded worker-pool degree once, here,
  // so the budget menu (below) and the pool (further below) share ONE value.
  // The EFFECTIVE degree is `requestedConcurrency` after any lane-safety
  // downgrade — a `glob-auto`/`unknown` project is forced back to 1 (the pool
  // set-up below explains why and emits the warning). Default is 2 (THR-1);
  // `--concurrency 1` restores the sequential V1 contract. `report.concurrency`
  // is recorded at the pool phase (below), so it stays absent on the earlier
  // early-return paths (menu-cancel, no-candidates) that dispatch nothing.
  const requestedConcurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
  // V1.9.7 (THR-3, evidence-refused → correctness fix): TypeScript generation is
  // lane-UNSAFE for concurrency by construction, so it always runs serial
  // regardless of discovery mode. The TS verify runs a WHOLE-PROJECT `tsc --noEmit`
  // (src/verify/tsc.ts — no file positionals, driven by the project's tsconfig
  // `include`), and the generated test is written to disk (retry-loop.ts) OUTSIDE
  // the verify lane. So at K>1 a peer worker's in-flight/broken `.qunit.ts` — still
  // on disk during its out-of-lane refinement, and guaranteed inside the tsc
  // `include` by the TG-SCAFFOLD scope guard — would fail a SOUND candidate's
  // whole-project tsc and wrongly quarantine it. That is exactly the glob-auto
  // hazard (tsc globs the disk like a karma glob); the verify-lane `Semaphore(1)`
  // cannot prevent it (it serialises tsc TIMING, not file PRESENCE), and TS has no
  // in-lane registration gate the way karma does. THR-3's overlapping-verify
  // speed-up is negligible anyway (measured `tsc --noEmit` ~2.7s vs ~200-370s LLM
  // per candidate — verify is <1.5% of wall-clock) and 2×tsc memory is fine
  // (~596MB on the reference machine) — so this is a correctness refusal, not a
  // memory one. (A lint-only TS project without its own `tsc` runs only single-file
  // ui5lint+eslint and would be safe, but we force ALL TS serial for simplicity —
  // a real TS project ships `typescript`.) See SPEC §2.15 / §7.
  const laneSafeDiscovery =
    projectLanguage !== 'ts' &&
    (discoveryMode === 'testsuite-require' || discoveryMode === 'karma-files-glob');
  const effectiveConcurrency = laneSafeDiscovery ? requestedConcurrency : 1;
  const qunitCands: readonly QunitCandidate[] = wantQunit
    ? findQunitCandidates({
        projectRoot: options.projectRoot,
        controllers: scope.controllerJs,
        testLayout: layout,
      })
    : [];
  const opa5Cands: readonly Opa5Candidate[] = wantOpa5
    ? findOpa5Candidates({
        projectRoot: options.projectRoot,
        views: scope.viewXml,
        testLayout: layout,
      })
    : [];

  // V1.9.2 (TG-ACCEPT / FS-6) — the tsconfig-scope guard. A TS generated test is
  // accepted on `tsc --noEmit`, which `verify/tsc.ts` runs project-wide and which
  // only type-checks files inside the project tsconfig's `include` scope. If a
  // generated `.qunit.ts` would land OUTSIDE that scope, tsc silently ignores it
  // and a "tsc passed" accept is vacuous — a green that proves nothing. Fail
  // CLOSED here, before any LLM call: refuse with an actionable message rather
  // than emit a false static-only pass. Gated on `tscEnabled` (when the project
  // ships no `typescript`, tsc is skipped and scope is moot — ui5lint still
  // type-checks the `.ts`). JS is unaffected. Mirrors the TG-SCAFFOLD-DEFER
  // pre-flight refusal precedent above.
  if (projectLanguage === 'ts' && tscEnabled && qunitCands.length > 0) {
    const tsScope = loadTsconfigScope(options.projectRoot);
    const uncovered = qunitCands.find((c) => !tsScope.covers(c.expectedTestAbs));
    if (uncovered !== undefined) {
      const includeDesc = tsScope.found
        ? `tsconfig.json "include" (${tsScope.include.join(', ') || 'none'})`
        : 'a readable tsconfig.json';
      outputStream.write(
        'sapui5-validate: generate for a TypeScript project cannot statically ' +
          `verify "${uncovered.expectedTestRel}" — it is outside ${includeDesc}, ` +
          'so `tsc --noEmit` would not type-check the generated test (the accept ' +
          'check would be vacuous). Add the test directory (e.g. webapp/test/unit) ' +
          'to tsconfig.json "include", then re-run.\n',
      );
      return finish({
        exitReason: {
          kind: 'error',
          message:
            'TypeScript generate refused: generated tests fall outside the ' +
            'project tsconfig.json "include" scope, so tsc cannot type-check them.',
        },
        exitCode: 1,
      });
    }
  }

  // V1.3-4: surface registration limitations once per run, on stderr so a
  // `--json` run's stdout stays clean.
  if (wantQunit && qunitCands.length > 0 && discoveryMode === 'unknown') {
    outputStream.write(
      'sapui5-validate: could not determine how this project discovers QUnit ' +
        'tests (no sap.ui.require testsuite.qunit.html, no karma files: list) — ' +
        'generated tests are written and verified but NOT auto-registered. Add ' +
        'them to your test suite manually so karma executes them.\n',
    );
  }
  if (wantOpa5) {
    outputStream.write(
      'sapui5-validate: --opa5-only — OPA5 journeys are generated but not ' +
        'auto-registered; add them to your OPA5 suite manually ' +
        '(auto-registration is out of V1 scope).\n',
    );
  } else if (options.opa5Only === true && projectLanguage === 'ts') {
    // V1.9.2 (TG-OPA5-DEFER) — be explicit instead of silently doing nothing:
    // OPA5-for-TS is deferred, so a TS `--opa5-only` run generates no journeys.
    outputStream.write(
      'sapui5-validate: --opa5-only — OPA5 generation for TypeScript projects ' +
        'is deferred to a later cycle; no OPA5 journeys were generated. ' +
        'Re-run without --opa5-only to generate QUnit tests.\n',
    );
  }

  // 8b. V1.3.1-5 — LLM-call estimate + interactive call-limit menu, bringing
  //     `generate` to `validate` parity on cost transparency. The estimate is
  //     computed AFTER candidate discovery (so the candidate count is exact)
  //     and BEFORE the generator loop (so the user can raise the budget before
  //     any LLM call fires). The estimate banner is emitted through the
  //     resolved `outputStream` via `progress` (hard-gated on `json !== true`,
  //     so a `--json` run's stdout stays a clean report contract). The menu
  //     fires only when the recommended count exceeds the current budget; it
  //     is suppressed under `--no-prompt`, under `--json`, and — inside
  //     `promptCallLimitChoice` — under a non-TTY stdin. The `json !== true`
  //     menu-gate term keeps `--json` fully non-interactive; without it a
  //     `--json` run on a TTY would print the menu and corrupt the JSON
  //     contract. (validate gained the same guard in V1.5 / C1.)
  const estimate = estimateCallsForGenerate({
    qunitCandidates: qunitCands.length,
    opa5Candidates: opa5Cands.length,
  });
  if (estimate.candidateCount > 0) {
    progress(
      `Estimated ${estimate.minimum}-${estimate.recommended} LLM calls to generate ` +
        `${estimate.candidateCount} test${estimate.candidateCount === 1 ? '' : 's'} ` +
        `(call budget: ${budget.maxCalls}).`,
    );
    // V1.3.2-4 (AM5) — observability for the V1.3.2-4 dialect detection. Sits
    // inside the candidate-gate so a no-candidate run's stderr stays empty;
    // routed through `progress` so a `--json` run's stdout stays a clean
    // report contract (the field is also on `report.sinonDialect`).
    progress(`sinon dialect: ${sinonDialect}`);
  }
  if (
    estimate.recommended > budget.maxCalls &&
    options.noPrompt !== true &&
    options.json !== true &&
    // COR-13b (§2.1): respect the documented `interactive` contract on the menu
    // path too (the no-tests template picker already does). An explicit
    // `interactive: false` suppresses the menu even on a TTY — closing the gap
    // where the flag was a dead input here. `undefined` (callers/tests that do
    // not set it) preserves the prior gate behaviour.
    options.interactive !== false
  ) {
    const header = `Detected ${estimate.candidateCount} controllers/views needing tests.`;
    const choice =
      options.menuIo !== undefined
        ? await promptCallLimitChoice(
            budget.maxCalls,
            estimate.recommended,
            estimate,
            options.menuIo,
            header,
            effectiveConcurrency,
          )
        : await promptCallLimitChoice(
            budget.maxCalls,
            estimate.recommended,
            estimate,
            undefined,
            header,
            effectiveConcurrency,
          );
    if (choice.action === 'cancel') {
      // Reuses the command-agnostic `cancelled-by-user` exit reason (exit 0),
      // identical to `validate`'s menu-cancel path.
      return finish({ exitReason: { kind: 'cancelled-by-user' }, exitCode: 0 });
    }
    if (choice.newLimit !== undefined && choice.newLimit !== budget.maxCalls) {
      budget = new CallBudget({ maxCalls: choice.newLimit });
    }
    // V1.9.4 PERF-17 — the opt-in model choice rides the SAME large-run moment
    // (this block is already gated on `--no-prompt`/`--json`/`interactive`).
    // Skipped when `--model` was explicit (model already set); `promptModelChoice`
    // owns the non-TTY short-circuit. A TS project triggers the static-only
    // quality warning. Never a silent default-down.
    if (model === undefined) {
      const modelChoice = await promptModelChoice(options.menuIo, {
        isTypeScript: projectLanguage === 'ts',
      });
      if (modelChoice.model !== undefined) model = modelChoice.model;
    }
  }

  const explicitTargetSet = explicitTargetRels(scope, options);

  // 8c. V1.6 / V1.9.7 (THR-1) — process candidates with a bounded worker pool of
  //     degree `--concurrency` (default 2; `--concurrency 1` = the SPEC §2.15
  //     sequential V1 contract, byte-identical to the pre-V1.6 loop). The
  //     expensive `claude -p` generation calls overlap; the cheap verify+register
  //     step is serialised through ONE run-wide verify lane (a Semaphore(1)), so
  //     a concurrent worker's not-yet-verified test can never leak into another
  //     worker's whole-suite karma run (SPEC §1.2 verify-then-accept). The pool's
  //     bounded degree doubles as the shared LLM-concurrency limiter.
  //
  //     Concurrency is honoured only where the lane is sufficient.
  //     `testsuite-require` and `karma-files-glob` load ONLY the registered
  //     modules/files, so the in-lane registration fully controls what karma
  //     executes. `glob-auto`/`unknown` auto-collect any on-disk *.qunit.js via a
  //     karma glob, where the lane cannot keep a parallel worker's in-progress
  //     file out — so the run falls back to serial there. TypeScript falls back
  //     to serial for the analogous reason (its whole-project `tsc --noEmit`
  //     globs the disk — see the `laneSafeDiscovery` guard above).
  //     `requestedConcurrency`
  //     / `laneSafeDiscovery` / `effectiveConcurrency` were resolved up front
  //     (for the budget menu + `report.concurrency`); here the pool consumes them
  //     and warns if the lane forced a downgrade.
  if (requestedConcurrency > 1 && effectiveConcurrency === 1) {
    progress(
      projectLanguage === 'ts'
        ? `--concurrency ${requestedConcurrency} requested, but TypeScript ` +
            `generation runs serially: the verify step is a whole-project ` +
            `tsc --noEmit that would see a parallel worker's in-progress test ` +
            `file on disk and wrongly fail a sound candidate (V1.9.7 THR-3). ` +
            `See SPEC §2.15.`
        : `--concurrency ${requestedConcurrency} requested, but this project ` +
            `auto-discovers QUnit tests via a karma glob (no sap.ui.require ` +
            `testsuite.qunit.html, no explicit files: list). Running serially to ` +
            `preserve verify-then-accept — a parallel karma run would execute ` +
            `another worker's in-progress test. See SPEC §2.15.`,
    );
  }
  // V1.9.7 (THR-1) — record the EFFECTIVE dispatch width now the pool is about to
  // run (past the menu / no-candidate early-returns), so `report.concurrency`
  // stays absent on runs that dispatch nothing — mirrors validate's batch-phase
  // placement and the RunReport.concurrency contract.
  report.concurrency = effectiveConcurrency;
  // V1.9.9 — mirror validate.ts's run-level verification marker on the generate
  // command: a TS run accepts tests on the static-only lane (ui5lint + tsc +
  // gated eslint, NEVER karma — the never-build firewall), so the report and the
  // CLI banner must say the accepted tests were not executed. Same D1 depth
  // gate as validate: 'static-only' only when tsc actually ran. Placed here
  // (past the menu / no-candidate early-returns, before the pool) so every run
  // that can accept a test carries the marker; a run that dispatches nothing
  // has nothing to overstate. JS runs never set it (karma executes their tests).
  if (projectLanguage === 'ts') {
    report.verification = tscEnabled ? 'static-only' : 'lint-only';
  }
  // One verify lane per run, shared across the QUnit and OPA5 phases. Undefined
  // on the sequential path — no lock, identical to the pre-V1.6 behaviour.
  const verifyLane = effectiveConcurrency > 1 ? new Semaphore(1) : undefined;
  // THR-4 (V1.9.7) — one pool-wide rate-limit signal per run, shared across the
  // QUnit and OPA5 phases (they run sequentially, never overlapping). On any
  // worker's 429 backoff it drains new dispatches until the window clears, then
  // restores K — so K parallel `claude -p` calls don't each burn their own
  // backoff schedule + budget against a hot quota window. Undefined on the
  // sequential path (no peers to drain), keeping that path byte-identical.
  const rateLimitSignal = effectiveConcurrency > 1 ? new RateLimitSignal() : undefined;

  // Terminal signals (V1.3-3 / V1.3-5): a dead karma runner, an exhausted
  // budget, or a hot rate-limit window stop the pool from starting new
  // candidates; in-flight candidates still finish. `rateLimitError` is the
  // error object (not a bare boolean) so `.message` feeds the `rate-limited`
  // exit reason's `lastError`, mirroring `validate.ts`.
  const terminal: PoolTerminal = {
    karmaUnavailable: false,
    budgetExhausted: false,
    rateLimitError: null,
    contractMismatchError: null,
  };

  const generated: ReportGeneratedTest[] = [];
  generated.push(
    ...(await runGeneratorPool(
      qunitCands.map((cand) => ({
        sourceRel: cand.controllerRel,
        testRel: cand.expectedTestRel,
        // V1.4-4 pre-flight skip: a controller importing an unpreloaded lib was
        // flagged by the baseline check; without `--auto-apply-baseline-fixes`
        // any generated test would quarantine on the karma module-load failure,
        // so it is recorded `skipped-baseline` (no LLM call) instead.
        skip: skippedControllerRels.has(cand.controllerRel),
        // V1.9.2 (TG-REPORT / FS-8) — a TS QUnit pass was accepted on the static
        // lane, NEVER executed by karma (the never-build firewall). Mark it so a
        // `passed` entry cannot overstate what was verified. JS QUnit tests are
        // karma-executed → no marker. V1.9.3 (D1) — the marker is a faithful
        // proxy for what actually ran: `'static-only'` (ui5lint + tsc + eslint)
        // only when the project ships its own `tsc` (`tscEnabled`); otherwise
        // `tsc` was skipped and the lane narrowed to ui5lint, so `'lint-only'`
        // (the per-test enum already carries both) — never claim "type-checked"
        // when tsc did not run.
        ...(projectLanguage === 'ts'
          ? { verification: tscEnabled ? ('static-only' as const) : ('lint-only' as const) }
          : {}),
        run: () =>
          generateQunitTest({
            candidate: cand,
            projectRoot: options.projectRoot,
            runner,
            budget,
            eslintEnabled,
            verifyFn,
            namespace,
            discoveryMode,
            sinonDialect,
            // V1.9.2 (TG-LANG-WIRE) — thread the language onto GenerateContext so
            // each per-attempt verify input routes to the static-only TS lane
            // (no karma); `tscEnabled` gates the tsc step. JS is byte-identical
            // (verify routes on `language === 'ts'`).
            projectLanguage,
            ...(tscEnabled ? { tscEnabled } : {}),
            // V1.9.4 PERF-17 — forward the resolved per-run model to the
            // generate call.
            ...(model !== undefined ? { model } : {}),
            // V1.4-5 — thread the dependency graph so the prompt builder
            // appends the pre-registered-stub context block when this
            // controller imports an unpreloaded lib.
            projectGraph,
            ...(verifyLane !== undefined ? { verifyLane } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            // V1.9.3 (D2) — test-only instant backoff sleeper; unset in
            // production (real SPEC §2.12 waits). Threaded on the QUnit path
            // only: TS defers OPA5, so this is the sole generate path a
            // deterministic rate-limit-backoff witness drives.
            ...(options.backoffSleeper !== undefined
              ? { backoffSleeper: options.backoffSleeper }
              : {}),
            // THR-4 (V1.9.7) — the run-wide pool signal (concurrent runs only);
            // a 429 backoff on this candidate drains peer dispatch.
            ...(rateLimitSignal !== undefined ? { rateLimitSignal } : {}),
          }),
      })),
      effectiveConcurrency,
      terminal,
      rateLimitSignal,
    )),
  );

  // A terminal signal in the QUnit phase skips OPA5 — burning more LLM calls
  // against a hot rate-limit window or a dead karma runner is pointless
  // (`validate` does the same; OPA5 journeys verify through the same runner).
  if (
    !terminal.budgetExhausted &&
    terminal.rateLimitError === null &&
    !terminal.karmaUnavailable
  ) {
    generated.push(
      ...(await runGeneratorPool(
        opa5Cands.map((cand) => ({
          sourceRel: cand.viewRel,
          testRel: cand.journeyTestRel,
          skip: false,
          // R2.5 (AUDIT §5.7e) — journeys are never registered, so outside
          // glob-auto the whole-suite karma run cannot execute them: their
          // `passed` is lint-only and the report entry says so. On glob-auto
          // the broad `files:` glob collects the journey, so karma genuinely
          // ran it and no marker is added.
          ...(discoveryMode !== 'glob-auto'
            ? { verification: 'lint-only' as const }
            : {}),
          run: () =>
            generateOpa5Journey({
              candidate: cand,
              projectRoot: options.projectRoot,
              runner,
              budget,
              eslintEnabled,
              verifyFn,
              namespace,
              // R2.5 — quarantine containment parity (see opa5.ts).
              discoveryMode,
              // V1.9.4 PERF-17 — forward the resolved per-run model.
              ...(model !== undefined ? { model } : {}),
              // V1.4-5 — same threading as the QUnit loop.
              projectGraph,
              ...(verifyLane !== undefined ? { verifyLane } : {}),
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
              // THR-4 (V1.9.7) — same pool signal as the QUnit phase.
              ...(rateLimitSignal !== undefined ? { rateLimitSignal } : {}),
            }),
        })),
        effectiveConcurrency,
        terminal,
        rateLimitSignal,
      )),
    );
  }

  // Surface the pool's terminal flags under the names the exit cascade reads.
  const budgetExhausted = terminal.budgetExhausted;
  const karmaUnavailable = terminal.karmaUnavailable;
  const rateLimitError = terminal.rateLimitError;
  const contractMismatchError = terminal.contractMismatchError;

  // 9. Exit code & reason (SPEC §2.19).
  let exitReason: ExitReason = { kind: 'success' };
  let exitCode = 0;
  const passed = generated.filter((g) => g.status === 'passed');
  // Every non-passed entry blocks exit 0 — `quarantined` (a real file under
  // webapp/test/_failing/) and `no-output` (no file was ever written) alike.
  const failed = generated.filter((g) => g.status !== 'passed');

  if (contractMismatchError !== null) {
    // TR-2 (V1.9.6): a systemic CLI-contract drift outranks the other terminal
    // signals — it means no call in the run could produce a usable envelope.
    exitReason = {
      kind: 'envelope-contract-mismatch',
      ...(report.claudeVersion !== undefined ? { version: report.claudeVersion } : {}),
      file: contractMismatchError.errorFilePath,
    };
    exitCode = 1;
  } else if (rateLimitError !== null) {
    exitReason = {
      kind: 'rate-limited',
      callsCompleted: budget.callsUsed,
      lastError: rateLimitError.message,
    };
    exitCode = 1;
  } else if (budgetExhausted) {
    exitReason = { kind: 'budget-exhausted', calls: budget.callsUsed };
    exitCode = 1;
  } else if (karmaUnavailable) {
    // V1.3-5: an unrunnable karma runner is a run-terminating abort, not a
    // per-finding outcome — surfaced before the unfixed-findings checks.
    exitReason = { kind: 'karma-unavailable' };
    exitCode = 1;
  } else if (
    failed.length > 0 &&
    explicitTargetSet !== null &&
    failed.some((q) => explicitTargetSet.has(q.sourceFile))
  ) {
    // SPEC §2.19: a failed test for an *explicitly requested* file
    // blocks exit 0 even if other generations succeeded.
    exitReason = { kind: 'unfixed-findings', remaining: failed.length };
    exitCode = 1;
  } else if (passed.length === 0 && failed.length > 0) {
    exitReason = { kind: 'unfixed-findings', remaining: failed.length };
    exitCode = 1;
  }

  return finish({ generatedTests: generated, exitReason, exitCode });
}

function makeVerifyFn(
  adapters?: VerifyAdapters,
): (input: VerifyPipelineInput) => Promise<VerifyResult> {
  if (adapters === undefined) return verifyArtifact;
  return (input) =>
    verifyArtifact({
      ...input,
      adapters: { ...adapters, ...(input.adapters ?? {}) },
    });
}

/**
 * V1.3-6 — render the baseline karma probe's {@link KarmaResult} for the
 * audit log. The probe calls the karma adapter directly (bypassing
 * `wrapVerifyFnWithAudit`), so it dumps its own `last-run/verify/` record
 * here, mirroring the shape `wrapVerifyFnWithAudit` writes for the
 * retry-loop karma step.
 */
function formatKarmaProbeAudit(km: KarmaResult): string {
  return [
    'step: karma (V1.3-6 baseline probe)',
    `ok: ${km.ok}`,
    `exitCode: ${km.exitCode}`,
    `durationMs: ${km.durationMs}`,
    '',
    '--- stdout ---',
    km.stdout,
    '',
    '--- stderr ---',
    km.stderr,
    '',
  ].join('\n');
}

const manifestNamespaceSchema = z
  .object({ 'sap.app': z.object({ id: z.string().min(1) }).passthrough() })
  .passthrough();

function readNamespace(projectRoot: string): string {
  const p = join(projectRoot, 'webapp', 'manifest.json');
  if (!existsSync(p)) return 'app';
  try {
    const parsed = manifestNamespaceSchema.safeParse(parseJsonWithBom(readFileSync(p, 'utf8')));
    if (!parsed.success) return 'app';
    return parsed.data['sap.app'].id;
  } catch {
    return 'app';
  }
}

function toReportEntry(
  sourceFileRel: string,
  expectedTestFileRel: string,
  outcome: Awaited<ReturnType<typeof generateQunitTest>>,
): ReportGeneratedTest {
  if (outcome.kind === 'generated') {
    return {
      sourceFile: sourceFileRel,
      testFile: outcome.testFileRel,
      status: 'passed',
      ...(outcome.refinementTruncations !== undefined && outcome.refinementTruncations > 0
        ? { refinementTruncations: outcome.refinementTruncations }
        : {}),
    };
  }
  if (outcome.kind === 'quarantined') {
    return {
      sourceFile: sourceFileRel,
      testFile: outcome.quarantinedAtRel,
      status: 'quarantined',
      quarantineReason: { phase: outcome.phase, message: outcome.reason },
      ...(outcome.refinementTruncations !== undefined && outcome.refinementTruncations > 0
        ? { refinementTruncations: outcome.refinementTruncations }
        : {}),
    };
  }
  if (outcome.kind === 'no-output') {
    // 'no-output' — no file was ever written. Report the intended path so the
    // user sees which generation failed, but with `status: 'no-output'`
    // (LOW B) rather than fabricating a `quarantined` entry against a missing
    // file.
    return {
      sourceFile: sourceFileRel,
      testFile: expectedTestFileRel,
      status: 'no-output',
      ...(outcome.phase !== undefined
        ? { quarantineReason: { phase: outcome.phase, message: outcome.reason } }
        : {}),
    };
  }
  // 'karma-unavailable' — a terminal abort (V1.3-5). The orchestrator
  // intercepts this outcome before calling `toReportEntry` (the aborting
  // candidate gets no report entry), so reaching here means a caller
  // mis-routed it. Throw rather than silently misclassifying it as
  // `no-output`.
  throw new Error(
    `toReportEntry received a terminal 'karma-unavailable' outcome for ` +
      `${sourceFileRel}; the orchestrator must intercept it before reporting.`,
  );
}

interface PoolTerminal {
  karmaUnavailable: boolean;
  budgetExhausted: boolean;
  rateLimitError: RateLimitExhaustedError | null;
  // TR-2 (V1.9.6): a systemic envelope-contract drift stops the pool like the
  // other terminal signals and finalises with the version-named exit reason.
  contractMismatchError: ClaudeEnvelopeContractError | null;
}

interface PooledCandidate {
  /** Project-relative source (controller / view) → `report.sourceFile`. */
  readonly sourceRel: string;
  /** Project-relative intended test path → `report.testFile` on a non-pass. */
  readonly testRel: string;
  /** True for a V1.4-4 pre-flight `skipped-baseline` candidate (no LLM call). */
  readonly skip: boolean;
  /**
   * R2.5 (AUDIT §5.7e) — set for a candidate whose `passed` verification does
   * not include a karma EXECUTION. `'lint-only'` (OPA5 journeys outside
   * glob-auto discovery) and, since V1.9.2 (TG-REPORT), `'static-only'` (a TS
   * QUnit test accepted on the static lane — ui5lint + tsc + eslint, never
   * karma). Stamped onto the report entry on a pass only — quarantined /
   * no-output entries claim no verification to qualify.
   */
  readonly verification?: 'lint-only' | 'static-only';
  /** Run the generator (QUnit or OPA5) for this candidate. */
  run(): Promise<GenerateOutcome>;
}

/**
 * V1.6 — run `cands` through a bounded worker pool of `concurrency` workers,
 * preserving deterministic candidate-order report entries (results land in a
 * per-candidate slot, never appended in completion order). This is the single
 * seam where `generate`'s concurrency lives; at `concurrency === 1` it is one
 * worker pulling candidates in order and stopping on the first terminal signal
 * — byte-identical to the pre-V1.6 `outer: for` loop.
 *
 * Terminal handling (V1.3-3 / V1.3-5): a `karma-unavailable` outcome, a
 * `RateLimitExhaustedError`, or a `BudgetExhaustedError` flips the shared
 * `terminal` record and stops new candidates from being claimed; candidates
 * already in flight finish and keep their entries. RateLimit is checked before
 * Budget, matching `validate.ts`'s catch-arm order. An unexpected error stops
 * the pool and is rethrown after the in-flight workers wind down, so it
 * propagates exactly as the serial loop's `throw err` did (and no sibling
 * worker's resolution becomes an unhandled rejection).
 */
async function runGeneratorPool(
  cands: readonly PooledCandidate[],
  concurrency: number,
  terminal: PoolTerminal,
  // THR-4 (V1.9.7): the run-wide pool rate-limit signal. When set, a worker
  // pauses before claiming a NEW candidate while any peer is in a 429 backoff
  // window (see the gate below). Undefined on the sequential path → the gate is
  // a no-op and dispatch is byte-identical to the pre-V1.9.7 loop.
  signal?: RateLimitSignal,
): Promise<ReportGeneratedTest[]> {
  const results = new Array<ReportGeneratedTest | undefined>(cands.length);
  let cursor = 0;
  let stop = false;
  let unexpected: unknown = null;

  const claimNext = (): number => {
    if (stop || cursor >= cands.length) return -1;
    const i = cursor;
    cursor += 1;
    return i;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      // THR-4 (V1.9.7): before claiming NEW work, wait out any active rate-limit
      // backoff window so K parallel workers don't each hammer a hot quota
      // window. Gating BEFORE claimNext keeps a paused worker candidate-free, and
      // budget (charged deep inside cand.run()) is untouched — the candidate is
      // drained, not dispatched. Instant when signal is undefined (sequential
      // path) or no window is active. On a terminal exhaustion the backing-off
      // schedule's finally reopens the window, so a parked worker wakes, sees
      // `stop`, and exits via claimNext() → -1 (no deadlock).
      if (signal !== undefined) await signal.waitUntilClear();
      const i = claimNext();
      if (i < 0) return;
      const cand = cands[i]!;
      if (cand.skip) {
        results[i] = {
          sourceFile: cand.sourceRel,
          testFile: cand.testRel,
          status: 'skipped-baseline',
        };
        continue;
      }
      try {
        const outcome = await cand.run();
        if (outcome.kind === 'karma-unavailable') {
          // V1.3-5: a dead karma runner is a terminal abort. The aborting
          // candidate gets NO report entry (nothing was quarantined).
          terminal.karmaUnavailable = true;
          stop = true;
          continue;
        }
        const entry = toReportEntry(cand.sourceRel, cand.testRel, outcome);
        // R2.5 — qualify a lint-only pass so `passed` cannot overstate what
        // was verified (the entry records the verification depth).
        results[i] =
          cand.verification !== undefined && entry.status === 'passed'
            ? { ...entry, verification: cand.verification }
            : entry;
      } catch (err) {
        if (err instanceof RateLimitExhaustedError) {
          terminal.rateLimitError = err;
          stop = true;
          results[i] = quarantineEntryFromTerminalError(cand.sourceRel, cand.testRel, err);
          continue;
        }
        if (err instanceof BudgetExhaustedError) {
          terminal.budgetExhausted = true;
          stop = true;
          results[i] = quarantineEntryFromTerminalError(cand.sourceRel, cand.testRel, err);
          continue;
        }
        if (err instanceof ClaudeEnvelopeContractError) {
          // TR-2 (V1.9.6): systemic CLI-contract drift — stop the pool like the
          // karma-unavailable abort (no per-candidate quarantine); the run
          // finalises with the version-named `envelope-contract-mismatch` reason.
          terminal.contractMismatchError = err;
          stop = true;
          continue;
        }
        unexpected = err;
        stop = true;
        return;
      }
    }
  };

  const degree = Math.min(Math.max(1, concurrency), Math.max(1, cands.length));
  await Promise.all(Array.from({ length: degree }, () => worker()));
  if (unexpected !== null) throw unexpected;
  return results.filter((e): e is ReportGeneratedTest => e !== undefined);
}

function quarantineEntryFromTerminalError(
  sourceRel: string,
  expectedRel: string,
  err: BudgetExhaustedError | RateLimitExhaustedError,
): ReportGeneratedTest {
  const info = getTerminalQuarantineInfo(err);
  if (info === undefined) {
    // R1.2 (AUDIT §5.6a): the terminal signal killed the INITIAL call, so no
    // file was ever written. `quarantined` always names a real file under
    // `_failing/` (types.ts) — fabricating one here would point the user at
    // a path that does not exist. `testFile` carries the intended target,
    // and `status: 'no-output'` says nothing reached disk.
    return {
      sourceFile: sourceRel,
      testFile: expectedRel,
      status: 'no-output',
      quarantineReason: { phase: 'initial', message: err.message },
    };
  }
  return {
    sourceFile: sourceRel,
    testFile: info.quarantinedAtRel,
    status: 'quarantined',
  };
}

function explicitTargetRels(
  scope: Awaited<ReturnType<typeof resolveFileScope>>,
  options: GenerateOptions,
): ReadonlySet<string> | null {
  if (options.path === undefined) return null;
  const set = new Set<string>();
  for (const abs of scope.controllerJs) set.add(toProjectRel(abs, options.projectRoot));
  for (const abs of scope.viewXml) set.add(toProjectRel(abs, options.projectRoot));
  for (const abs of scope.qunitTest) set.add(toProjectRel(abs, options.projectRoot));
  return set;
}

function toProjectRel(abs: string, projectRoot: string): string {
  const a = abs.replace(/\\/g, '/');
  const r = projectRoot.replace(/\\/g, '/');
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
}

/**
 * Default readline-backed picker. Asks the user to choose 1/2/3 corresponding
 * to TEMPLATE_CHOICES. Returns null on EOF or invalid input — the orchestrator
 * surfaces that as `no-tests-template-required`.
 */
export const defaultTemplatePicker: TemplatePicker = async ({ namespace, choices }) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const lines = [
      `Project "${namespace}" has no existing tests under webapp/test/.`,
      'Pick a starter template (SPEC §2.4):',
      ...choices.map((c, i) => `  ${i + 1}) ${c}`),
      '',
    ].join('\n');
    process.stdout.write(`${lines}\n`);
    const answer = (await rl.question('Choice [1-3]: ')).trim();
    const ix = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(ix) || ix < 0 || ix >= choices.length) return null;
    return choices[ix] ?? null;
  } finally {
    rl.close();
  }
};

