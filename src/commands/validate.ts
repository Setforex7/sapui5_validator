/**
 * `sapui5-validate validate` orchestrator (SPEC §2.10, PLAN.md session 8).
 *
 * Flow:
 *   detect → ts-guard → git-clean → tooling probe → file scope →
 *   baseline verify → run check registry → apply-and-verify each finding's
 *   proposedFix in a 3-attempt loop (refine via LLM between attempts;
 *   revert single file on the 3rd failure) → write report + audit log.
 *
 * Every external boundary (git, exec, the `claude` binary, the verify
 * pipeline, fs probe) is injectable so the integration test can run the full
 * orchestrator headlessly against `minimal-project` with a fake runner and
 * deterministic verify stubs.
 *
 * Deviations from the plan (recorded for session 8 exit):
 *   - SPEC §2.3 baseline-fix-via-LLM is not implemented in this session. The
 *     orchestrator runs a project-level ui5lint/eslint pre-check; if it
 *     fails, the run aborts with exit reason `baseline-failed` rather than
 *     funnelling failures through the LLM fix loop. The fix-loop primitives
 *     this session introduces (`applyAndVerifyFix`) are designed so that
 *     plumbing baseline failures through them in session 10 is a small
 *     localised change.
 */

import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { AuditLog } from '../audit/log.js';
import { AuditingRunner, wrapVerifyFnWithAudit } from '../audit/runner.js';
import { collectBaselineFindings, makeBaselineLintProbe } from './baseline.js';
import { claudeVersionWarning, type ClaudeAvailability } from '../claude/availability.js';
import { buildClaudeArgs, type ClaudeRunner } from '../claude/runner.js';
import { RateLimitSignal } from '../claude/rate-limit-signal.js';
import { RunUsageAccumulator, formatUsageSummaryLine } from '../claude/usage.js';
import {
  CallBudget,
  DEFAULT_LLM_BUDGET,
  BudgetExhaustedError,
  RATE_LIMIT_BACKOFF_MS,
  withRateLimitBackoff,
  type Sleeper,
} from '../claude/budget.js';
import {
  createCapState,
  DEFAULT_PER_CHECK_CAP_PERCENT,
  getSkippedCounts,
  type CategoryCapState,
} from '../budget/cap.js';
import { estimateCallsForScope } from '../budget/estimator.js';
import {
  promptCallLimitChoice,
  promptModelChoice,
  type MenuIo,
} from '../budget/menu.js';
import {
  ClaudeApiError,
  ClaudeEnvelopeContractError,
  ClaudeProcessKilledError,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
} from '../claude/binary-runner.js';
import { CHECKS, runCheckLoop, type CheckTargetSet, type CheckLoopResult } from '../checks/index.js';
import { BATCHED_CHECK_IDS, runCheckBatches, type BatchPhaseResult } from '../checks/batch.js';
import { DetectionCache } from '../checks/cache.js';
import { checkUnpreloadedLibs } from '../checks/unpreloaded-libs.js';
import {
  triageCoverageTargets,
  type CoverageTriage,
} from '../checks/missing-test-coverage.js';
import { buildProjectGraph } from '../project/dependency-graph.js';
import { globProjectFiles } from '../project/glob-project.js';
import {
  describeRateLimitedResult,
  isRateLimitedApiError,
  isRateLimitedResult,
  rateLimitExhaustedFromError,
  systemPromptFor,
} from '../checks/_shared.js';
import type { CheckContext, CheckModule, CheckScope } from '../checks/types.js';
import {
  detectSapUi5Project,
  hasProjectTypeScript,
  hasTsAwareEslintConfig,
} from '../project/detect.js';
import type { ProjectLanguage } from '../project/detect.js';
import {
  BASE_REF_FALLBACK_CHAIN,
  changedFilesSinceWithFallback,
  GitNoRepositoryError,
  isWorkingTreeClean,
  type GitClient,
} from '../project/git.js';
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
import { prepareFeedbackForPrompt } from '../util/prompt-feedback.js';
import { createEmptyReport, writeReport } from '../output/report.js';
import { writeHtmlReport } from '../output/html.js';
import type {
  ExitReason,
  Finding,
  PostFixSuiteOutcome,
  ReportFileEntry,
  RunReport,
} from '../types.js';
import { fixProposalSchema, safeJson } from '../util/schema.js';
import {
  karmaRunnerUnavailable,
  verifyArtifact,
  type VerifyAdapters,
  type VerifyPipelineInput,
  type VerifyResult,
} from '../verify/pipeline.js';

export interface ValidateOptions {
  readonly projectRoot: string;
  /** Optional file path (relative or absolute) scoping the run to one file. */
  readonly path?: string;
  readonly all?: boolean;
  readonly base?: string;
  readonly verbose?: boolean;
  readonly maxLlmCalls?: number;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly keepHistory?: boolean;
  /**
   * V1.2-1 (Feature 1, Session V1.2-1): when true, skip the interactive
   * call-limit menu entirely. Used by CI/automation callers that pipe stdin
   * but still want the menu suppressed (the implicit non-TTY fallback inside
   * `promptCallLimitChoice` is not always reachable — e.g. when the parent
   * process inherits a TTY but the run should still be silent).
   */
  readonly noPrompt?: boolean;
  /**
   * V1.2-6 (Feature 3 — HTML report). When true, after `report.json` is
   * written the orchestrator also renders `report.html` next to it
   * (`.sapui5-validator/report.html`). Failure to write the HTML is
   * swallowed the same way `writeReport` failures are — the HTML is a
   * non-blocking presentation artifact, not part of the run's success
   * contract. Defaults to `false` so existing callers see no behaviour
   * change.
   */
  readonly html?: boolean;
  /**
   * V1.4-4 (AP3) — when true, the deterministic manifest.json fix for
   * `baseline-unpreloaded-libs` findings is applied automatically (no LLM
   * involvement) before the LLM check loop runs. Default off — mirrors
   * `--force` (clean-tree bypass) and `--all` (scope override) as an explicit
   * opt-in flag for behaviours that mutate user-owned config files beyond the
   * default verify-and-report. Without the flag the finding is surfaced and
   * contributes to the non-zero-exit accounting (unfixed-findings).
   */
  readonly autoApplyBaselineFixes?: boolean;
  /**
   * V1.9.8 — cross-run detection result cache. When true, unchanged batched
   * detection checks (the controller/view batches) are served from
   * `.sapui5-validator/cache/` instead of a live LLM call; the non-batched
   * loop checks, fix refinement, and all verification are NEVER cached.
   * `--force` bypasses cache READS (a forced run is a deliberate fresh
   * measurement) but fresh entries are still written.
   *
   * Defaults: the CLI defaults `--cache` ON since Phase 3's evidence-gated
   * flip (`--no-cache` opts out; the commander default is pinned by a guard
   * test). THIS programmatic option stays opt-in (undefined = off) so
   * existing embedders and the test suite keep byte-identical uncached
   * behaviour unless they ask for the cache.
   */
  readonly cache?: boolean;
  /**
   * V1.2-2 per-category call cap, as a percentage (1-100) of the final per-run
   * call limit. Defaults to {@link DEFAULT_PER_CHECK_CAP_PERCENT} when the
   * CLI does not pass a value. The validation `[1, 100]` and integer check
   * lives at the CLI parser boundary; the orchestrator trusts the value.
   */
  readonly perCheckCap?: number;
  /**
   * V1.9.7 (THR-2) — bounded width for the semantic-check BATCH phase
   * (`runCheckBatches`): process up to N controller/view findings-only calls at
   * once. Default 1 = sequential, byte-identical to pre-V1.9.7. Findings-only
   * calls have no verify/write hazard (the JS verify `Semaphore(1)` is a
   * generate concern), so the only shared state is the synchronously-guarded
   * budget + per-category cap accounting; determinism is preserved by per-index
   * result slots. At N>1 a run-wide {@link RateLimitSignal} drains new dispatch
   * during a peer's 429 backoff. The post-batch non-batched check loop stays
   * sequential. The K=2 default is a later phase; this flag lets adopters opt in.
   */
  readonly concurrency?: number;
  /**
   * V1.9.4 PERF-17 — explicit per-run model id (`--model <name>`). Free-form;
   * forwarded verbatim to every `claude -p` call via `buildClaudeArgs`. When set
   * it WINS and the opt-in model menu is skipped; when unset the menu may set a
   * model on a TTY large run, and absent that the binary picks the default (no
   * `--model` emitted). `src/` pins no id — only this user value is forwarded.
   */
  readonly model?: string;
  /**
   * Optional stream the orchestrator writes user-visible warnings to (e.g.
   * the V1.2-2 "perCategoryCap is 0" startup notice). Defaults to
   * `process.stderr` when omitted. Tests inject a memory writable so the
   * warning text can be asserted against.
   */
  readonly warningStream?: NodeJS.WritableStream;
  /**
   * Optional IO override for the V1.2-1 interactive call-limit menu. Tests
   * pass a paired Readable + memory Writable; production wiring lets the
   * menu default to `process.stdin`/`stdout`/`stderr`.
   */
  readonly menuIo?: MenuIo;
  /** Injection points (production callers leave unset). */
  readonly runner: ClaudeRunner;
  readonly gitImpl?: GitClient;
  readonly probeAdapter?: ProbeAdapter;
  /**
   * V1.4-10 — injectable CDN-availability probe threaded into
   * `buildProjectGraph` (offline test seam; production probes the karma
   * ui5.url CDN). See generate.ts for the rationale.
   */
  readonly probeLib?: (lib: string) => Promise<boolean>;
  readonly verifyAdapters?: VerifyAdapters;
  readonly verifyFn?: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  /**
   * SPEC §2.12 startup probe for the `claude` binary. The CLI passes the
   * default probe (`probeClaudeAvailability`). Integration tests omit it —
   * the in-memory `FakeClaudeRunner` makes the probe meaningless.
   */
  readonly availabilityProbe?: () => Promise<ClaudeAvailability>;
  readonly signal?: AbortSignal;
}

export interface ValidateRunResult {
  readonly report: RunReport;
  readonly exitCode: number;
  readonly reportPath?: string;
}

export const MAX_FIX_ATTEMPTS = 3;

/**
 * V1.9.4 (PERF-12) — byte cap for the file content embedded verbatim in a
 * refinement prompt (`requestRefinedFix`); rationale re-derived V1.9.6-3 for
 * the stdin transport.
 *
 * A refinement prompt carries TWO volatile payloads: this file content AND the
 * verify feedback (capped at {@link MAX_PROMPT_FEEDBACK_BYTES} = 16 KiB). Both
 * change on every attempt, so — unlike the cacheable system-prompt + tool-list
 * prefix — they are re-sent as uncacheable input on each of up to
 * {@link MAX_FIX_ATTEMPTS} retries. Pre-V1.9.6 the joint motive was the Windows
 * `CreateProcess` argv ceiling; since TR-1 the prompt travels on the child's
 * stdin, so that ceiling no longer applies and the cap is now purely a
 * *token-cost* bound. 12 KiB of content is ~3k uncacheable input tokens per
 * attempt; an oversized source file becomes a *degraded fix attempt* (capped +
 * a "return the FULL file" marker) rather than an unbounded payload multiplied
 * across retries. A file at or under the cap embeds byte-identically — no
 * prompt change vs pre-V1.9.4.
 *
 * Value kept at 12 KiB: the V1.9.5 baseline
 * (`docs/runs/v1.2.0-baseline/README.md`) measured 0 content truncations across
 * all 7 real runs, so the cap already fits every real SAPUI5 source file whole
 * and never constrained real work — no data justifies moving it. Counted in
 * UTF-8 bytes (the {@link prepareFeedbackForPrompt} unit), which tracks input
 * token cost.
 */
export const REFINE_CONTENT_CAP_BYTES = 12_288;

// V1.9.4 PERF-2/8 — the empty `runCheckLoop` result used when the batch phase
// already terminated the run (rate-limit hot / budget spent), so the non-batched
// loop checks are skipped without re-deriving any state.
const EMPTY_CHECK_LOOP_RESULT: CheckLoopResult = Object.freeze({
  findings: [],
  skipped: [],
  budgetExhausted: false,
  rateLimitExhausted: null,
});

export async function runValidate(options: ValidateOptions): Promise<ValidateRunResult> {
  const startedAt = new Date();
  // V1.2-1: budget is mutable — the interactive menu after scope resolution
  //   may replace it with a user-chosen limit. Until then it holds the CLI's
  //   `--max-llm-calls` value (or the SPEC §2.12 default of 50).
  let budget = new CallBudget({
    maxCalls: options.maxLlmCalls ?? DEFAULT_LLM_BUDGET,
  });
  // V1.9.4 PERF-17 — the resolved per-run model. Starts at the explicit
  // `--model` value (often unset); the opt-in model menu (large-run TTY moment,
  // below) may set it when `--model` was not supplied. Unset → no `--model` is
  // emitted and the binary picks the default (no model id in `src/`). `finish`
  // closes over it to record a non-default choice on `report.model`.
  let model: string | undefined = options.model;
  // V1.9.4 PERF-12 — run-level sum of refinement prompts whose embedded file was
  // byte-capped, accumulated across `applyAndVerifyFix` outcomes; `finish` closes
  // over it and records it on `RunReport.contentTruncations` only when > 0.
  let contentTruncations = 0;
  // V1.2-2: cap state is initialised AFTER the V1.2-1 menu may have resized
  //   the budget — see step 5c below. Held as a single-element mutable
  //   wrapper so the early-return finaliser closures see the eventual
  //   value (a bare `let` rebinds to undefined and trips `prefer-const`,
  //   because the rule does not count "uninitialised then assigned" as a
  //   reassignment).
  const capStateRef: { current?: CategoryCapState } = {};
  const warningStream = options.warningStream ?? process.stderr;
  const report = createEmptyReport('validate', startedAt, budget.maxCalls);
  // V1.9.7 (THR-1/THR-2) — the batch-phase dispatch width. `validate` has no
  // lane restriction (findings-only calls, no verify/write hazard), so the
  // effective K always equals the requested `--concurrency`. Resolved here so
  // the budget menu can state it; `report.concurrency` is set at the batch
  // phase (below), keeping it absent on early-exit paths that dispatch nothing.
  const checkConcurrency = options.concurrency ?? 1;
  const audit = new AuditLog({
    projectRoot: options.projectRoot,
    keepHistory: options.keepHistory === true,
    startedAt,
  });
  // V1.9.4 PERF-1 — the single run-level usage sink, fed by the AuditingRunner
  // decorator (the choke point every production call already flows through).
  const usage = new RunUsageAccumulator();
  const runner: ClaudeRunner = new AuditingRunner(options.runner, audit, (r) => usage.add(r));

  // V1.9.8 — the cross-run detection result cache (opt-in --cache). Loaded
  // SYNCHRONOUSLY into memory here so the HIT/MISS branch inside
  // `callLlmForFindingsBatch` inserts no `await` into its cap-check →
  // consume → record prelude. `--force` bypasses READS (a forced run is a
  // deliberate fresh measurement) but the run still writes fresh entries.
  // Declared before `finish` so every exit path can stamp the counters and
  // persist the store.
  const detectionCache =
    options.cache === true
      ? DetectionCache.load(options.projectRoot, {
          readEnabled: options.force !== true,
          // Phase 2 — entries this run writes are attributed to it via the
          // report's startedAt (the run id; no separate id concept exists).
          runId: report.startedAt,
        })
      : undefined;

  const finish = async (overrides?: Partial<RunReport>): Promise<ValidateRunResult> => {
    const finishedAt = new Date();
    const merged: RunReport = {
      ...report,
      ...(overrides ?? {}),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      llmCallCount: budget.callsUsed,
      llmCallBudget: budget.maxCalls,
      // V1.2-2: include `cappedChecks` only when the cap actually blocked
      //   something — keeps the field absent on runs where the cap never
      //   bit (matches the V1.2 plan: "least disruption to existing
      //   report consumers"). `overrides.cappedChecks` (set on the rare
      //   short-circuit paths before the cap state exists) wins if present.
      ...(overrides?.cappedChecks !== undefined
        ? {}
        : cappedChecksOverride(capStateRef.current)),
      // V1.9.4 PERF-1 — additive-optional summed usage/cost. Absent on
      // LLM-free runs (e.g. early-exit paths), so this never widens those
      // reports; `schemaVersion` stays 2.
      ...usage.toReportFields(),
      // V1.9.4 PERF-17 — record the non-default model the run used (absent when
      // the Claude Code default was used). Additive optional; `schemaVersion`
      // stays 2.
      ...(model !== undefined ? { model } : {}),
      // V1.9.4 PERF-12 — run-level count of byte-capped refinement prompts.
      // Absent when no fix prompt truncated (never a zero placeholder). An
      // `overrides.contentTruncations` (none today) would win if present.
      ...(overrides?.contentTruncations === undefined && contentTruncations > 0
        ? { contentTruncations }
        : {}),
      // V1.9.8 — run-level cache accounting, present IFF the run had the
      // detection cache enabled (hits/misses stay honest even on early-exit
      // and rate-limited partial runs). Additive optional; schemaVersion 2.
      ...(detectionCache !== undefined ? { cache: detectionCache.counters() } : {}),
    };
    // V1.9.8 — persist the (LRU-capped) cache store. Best-effort like the
    // report write below: a persist failure costs a future re-run, never the
    // current run's result.
    if (detectionCache !== undefined) {
      try {
        await detectionCache.persist();
      } catch {
        // non-blocking by design
      }
      // Phase 2 — the audit-trail hit records (key + file + source run per
      // served batch). Best-effort, same policy as writeClaudeVersion: the
      // durable accounting lives on report.cache.
      const hitRecords = detectionCache.hitRecords();
      if (hitRecords.length > 0) {
        try {
          await audit.writeCacheHits(hitRecords);
        } catch {
          // best-effort — mirrors the transcript-write policy.
        }
      }
    }
    let reportPath: string | undefined;
    try {
      await audit.init();
      reportPath = await writeReport(options.projectRoot, merged);
    } catch {
      // Surface report-write failures via the in-memory result; do not mask
      // an upstream non-zero exit with a secondary fs error.
    }
    // V1.2-6 (Feature 3): opt-in HTML render alongside report.json. Same
    // swallow-on-failure policy as writeReport — the HTML is a non-blocking
    // presentation artifact. The on-disk path is intentionally NOT returned
    // via ValidateRunResult: report.json remains the single authoritative
    // path; surfacing both would force every caller to choose.
    if (options.html === true) {
      try {
        await writeHtmlReport(options.projectRoot, merged);
      } catch {
        // ignore — same rationale as writeReport above.
      }
    }
    // V1.9.4 PERF-1 — one presence-gated cost/token summary line to the human
    // stream (stderr), suppressed under --json (report.json carries the fields)
    // and on LLM-free runs (formatUsageSummaryLine returns undefined).
    if (options.json !== true) {
      const usageLine = formatUsageSummaryLine(merged);
      if (usageLine !== undefined) {
        warningStream.write(`${usageLine}\n`);
      }
      // V1.9.8 Phase 2 — the cache honesty summary: presence-gated like the
      // usage line (only when something was actually served), naming the
      // populating run(s) so a consumer can trace served findings.
      if (merged.cache !== undefined && merged.cache.hits > 0) {
        const total = merged.cache.hits + merged.cache.misses;
        const runs = (merged.cache.servedRunIds ?? []).join(', ');
        warningStream.write(
          `${merged.cache.hits} of ${total} check calls served from cache (run ${runs})\n`,
        );
      }
    }
    return reportPath !== undefined
      ? { report: merged, exitCode: merged.exitCode, reportPath }
      : { report: merged, exitCode: merged.exitCode };
  };

  // 0. Claude binary probe (SPEC §2.12). Runs before any project-side work so
  //    an *uninstalled* `claude` fails fast with the documented message. A
  //    logged-out (installed) binary is NOT caught here — auth is exercised on
  //    the first LLM call (surfacing as a per-file ClaudeApiError), by design:
  //    no LLM call is spent before the user has consented. Tests omit the probe
  //    (the fake runner makes it moot); cli.ts injects the real probe.
  if (options.availabilityProbe !== undefined) {
    const availability = await options.availabilityProbe();
    if (!availability.ok) {
      return finish({ exitReason: { kind: 'missing-claude' }, exitCode: 1 });
    }
    // TR-2 (V1.9.6): record the CLI version (report.json + audit trail) so an
    // envelope-shape drift is attributable to a known version, and WARN — never
    // hard-fail — when it is outside the tested range. The audit stamp is
    // best-effort (report.json carries the durable record); a containment
    // escape is still caught fatally by ensureSelfScopedIgnore below.
    report.claudeVersion = availability.version;
    try {
      await audit.writeClaudeVersion(availability.version);
    } catch {
      // best-effort — same policy as the AuditingRunner transcript writes.
    }
    const versionWarning = claudeVersionWarning(availability.version);
    if (versionWarning !== null) {
      warningStream.write(`${versionWarning}\n`);
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

  // 2. TypeScript routing seam (SPEC §2.5). V1.9 Phase 2: `validate` PROCEEDS
  //    for a TS project (the static-only verify lane below); the guard returns
  //    the detected language. `generate` still refuses TS (see generate.ts).
  //    The residual honest-refusal floor for TS — a project with no usable
  //    static toolchain — is the tooling probe (ui5lint required) at step 4.
  const tsGuard = await checkTsGuard(options.projectRoot, { command: 'validate' });
  if (!tsGuard.ok) {
    return finish({
      exitReason: { kind: 'typescript-project' },
      exitCode: 1,
    });
  }
  const projectLanguage: ProjectLanguage = tsGuard.language;

  // 3. Clean-tree gate (SPEC §2.6) — bypassed by --force
  if (options.force !== true) {
    const cleanOpts = options.gitImpl !== undefined ? { gitImpl: options.gitImpl } : {};
    try {
      const clean = await isWorkingTreeClean(options.projectRoot, cleanOpts);
      if (!clean.clean) {
        return finish({ exitReason: { kind: 'dirty-tree' }, exitCode: 1 });
      }
    } catch (err) {
      // COR-1 (§2.6): only "no git repository" is treated as proceed — the
      // user gets full control via the file system anyway, and `--force`
      // already exists for explicit overrides. ANY OTHER git failure (corrupt
      // index, locked ref, permission error) must fail closed: swallowing it
      // as "clean" would silently disable the very gate that protects an
      // un-snapshotted tree.
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

  // SPEC §2.18: best-effort `.gitignore` auto-amend. Failure does not block
  //  the run — it's a courtesy, not a correctness requirement.
  try {
    await ensureValidatorDirIgnored(options.projectRoot);
  } catch {
    // ignore
  }

  // v0.8.1 V3: self-scoped `.sapui5-validator/.gitignore` — guarantees the
  // audit trail (full source + LLM transcripts) is never git-trackable, on
  // any project shape, independent of the root `.gitignore` courtesy amend
  // above. An OutsideProjectRootError means `.sapui5-validator` itself
  // escapes the project root (e.g. a committed symlink): every later
  // audit/report write would land out of tree, so abort loudly. Any other
  // failure is a warning, never silent.
  try {
    await ensureSelfScopedIgnore(options.projectRoot);
  } catch (err) {
    if (err instanceof OutsideProjectRootError) throw err;
    warningStream.write(
      `warning: could not write the self-scoped .gitignore for the audit trail ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `.sapui5-validator/ may be git-trackable on this project.\n`,
    );
  }

  // 4. Tooling probe (SPEC §2.11). V1.9: karma is NOT required for a TS project
  //    (the static-only lane never runs it), so a `projectLanguage` is threaded
  //    in. ui5lint stays required for both — that requirement IS the TS
  //    honest-refusal floor (a TS project with no usable static linter still
  //    refuses with `missing-required-tooling`, never a silent pass).
  const probe = await probeTooling(options.projectRoot, {
    adapter: options.probeAdapter ?? withNpxFallback(defaultProbeAdapter),
    projectLanguage,
  });
  if (probe.hardFail) {
    return finish({
      exitReason: { kind: 'missing-required-tooling', tools: probe.missingRequired },
      exitCode: 1,
    });
  }
  const eslintToolOk = probe.tools.find((t) => t.name === 'eslint')?.status === 'ok';
  // V1.9 G2-02/03 — on a TS project eslint participates ONLY when the project
  // ships a TS-aware eslint config (else a stock JS flat config parse-errors on
  // `.ts`; ui5lint covers it). JS is byte-identical (`tsEslintAware` is true).
  const tsEslintAware = projectLanguage === 'ts' ? hasTsAwareEslintConfig(options.projectRoot) : true;
  const eslintEnabled = eslintToolOk && tsEslintAware;
  // V1.9 TS-VERIFY — run `tsc --noEmit` in the verify lane only when the project
  // ships its own `tsc` (the CLI bundles no `typescript`). JS never runs tsc.
  const tscEnabled = projectLanguage === 'ts' && hasProjectTypeScript(options.projectRoot);
  // V1.9 TS-V1-FW — past the tooling gate a TS run is committed to the
  // static-only lane (ui5lint + config-gated eslint + tsc, NEVER karma). Mark
  // the report so the CLI + JSON honestly state that the test suite was not
  // executed; `finish()` spreads `report`, so every exit carries it. V1.9.3
  // (D1) — gate the depth on whether `tsc` actually ran: `'static-only'` only
  // when the project ships its own `tsc` (`tscEnabled`); otherwise `tsc` was
  // skipped (`pipeline.ts` runs it only `if (tscEnabled)`) and the lane
  // narrowed to ui5lint, so `'lint-only'` — the marker must not claim a
  // type-check that did not happen.
  if (projectLanguage === 'ts') {
    report.verification = tscEnabled ? 'static-only' : 'lint-only';
  }

  // 5. File scope resolution (SPEC §2.14). `projectLanguage` (from the ts-guard
  //    above) gates TS-aware discovery (GA1-01/04): a `'ts'` project enumerates
  //    `.ts`/`.qunit.ts` targets; `'js'` is byte-identical to the legacy path.
  const layout = detectTestLayout(options.projectRoot);
  let scope: FileScope;
  try {
    scope = await resolveFileScope({
      projectRoot: options.projectRoot,
      all: options.all === true,
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

  // 5a-bis. V1.9.1 (Fix C / I4) — deterministic coverage triage (NO LLM). A
  //     source no in-scope test imports is provably uncovered: every method is
  //     trivially uncovered, so the per-method `missing-test-coverage` LLM call
  //     yields only unactionable output (the fix is multi-file → `generate`).
  //     Triage those into ONE rolled-up finding and spend the LLM only on
  //     sources a test maps to. Conservative: with no in-scope tests the triage
  //     is a no-op (`mapped` = all controllers), keeping the original per-method
  //     behaviour (see triageCoverageTargets). Computed BEFORE the estimate so
  //     the budget menu reflects the reduced coverage call count.
  const coverageTriage: CoverageTriage = triageCoverageTargets({
    projectRoot: options.projectRoot,
    controllerTargets: scope.controllerJs,
    testFiles: scope.qunitTest,
    projectLanguage,
  });

  // 5b. V1.2-1 dynamic call-limit menu. The estimate is computed after scope
  //     resolution (so we know exactly which checks will dispatch and over how
  //     many targets) but BEFORE baseline + check loop (so the user can raise
  //     the limit before any LLM call fires). The menu only appears when the
  //     estimated recommended exceeds the current limit; otherwise the user
  //     is not bothered. `--no-prompt` + non-TTY stdin both short-circuit to
  //     "continue with current limit".
  //     V1.9.1 (Fix C / I4) — the coverage triage's mapped subset replaces the
  //     full controllerJs count for `missing-test-coverage` (count only the
  //     LLM-bound sources).
  const estimate = estimateCallsForScope({
    ...scope,
    coverageMappedControllerJs: coverageTriage.mapped,
  });
  // C1 (V1.5): the `options.json !== true` term mirrors generate's menu gate.
  // Without it, `validate --json` on an interactive TTY (e.g. `validate --json
  // | jq`, where stdin stays a terminal) renders the menu to process.stdout
  // ahead of the report JSON and corrupts the machine-readable contract
  // (SPEC §2.17). --json is treated as non-interactive on both commands.
  if (
    estimate.recommended > budget.maxCalls &&
    options.noPrompt !== true &&
    options.json !== true
  ) {
    const choice =
      options.menuIo !== undefined
        ? await promptCallLimitChoice(
            budget.maxCalls,
            estimate.recommended,
            estimate,
            options.menuIo,
            undefined,
            checkConcurrency,
          )
        : await promptCallLimitChoice(
            budget.maxCalls,
            estimate.recommended,
            estimate,
            undefined,
            undefined,
            checkConcurrency,
          );
    if (choice.action === 'cancel') {
      return finish({ exitReason: { kind: 'cancelled-by-user' }, exitCode: 0 });
    }
    if (choice.newLimit !== undefined && choice.newLimit !== budget.maxCalls) {
      budget = new CallBudget({ maxCalls: choice.newLimit });
    }
    // V1.9.4 PERF-17 — the opt-in model choice rides the SAME large-run moment
    // (this block is already gated on `--no-prompt`/`--json`; the call-limit menu
    // ran just above). Skipped when `--model` was explicit (model already set);
    // `promptModelChoice` owns the non-TTY short-circuit. A TS project triggers
    // the static-only quality warning. Never a silent default-down.
    if (model === undefined) {
      const modelChoice = await promptModelChoice(options.menuIo, {
        isTypeScript: projectLanguage === 'ts',
      });
      if (modelChoice.model !== undefined) model = modelChoice.model;
    }
  }

  // 5c. V1.2-2 per-category cap initialisation. Done AFTER the V1.2-1 menu
  //     so the cap reflects the user-resolved budget. A `perCategoryCap` of
  //     0 is a pathological combination (e.g. `--per-check-cap 5
  //     --max-llm-calls 10` → floor(50/100) = 0) that would skip every LLM
  //     call; we still create the state and warn the user rather than
  //     silently disable the entire LLM phase.
  const perCheckCap = options.perCheckCap ?? DEFAULT_PER_CHECK_CAP_PERCENT;
  const capState = createCapState(perCheckCap, budget.maxCalls);
  capStateRef.current = capState;
  if (capState.perCategoryCap === 0 && budget.maxCalls > 0) {
    warningStream.write(
      `warning: per-check-cap of ${perCheckCap}% on ${budget.maxCalls} total calls ` +
        `produces a per-category cap of 0; no LLM analysis will run. ` +
        `Increase --per-check-cap or --max-llm-calls.\n`,
    );
  }

  // 6. Baseline verify (SPEC §2.3). Per-file ui5lint/eslint failures become
  //    synthetic baseline findings that flow through the SAME fix loop as
  //    LLM check findings. Karma failures here are project-wide and abort
  //    the run with `baseline-failed` (the dedicated exit reason is reserved
  //    for failures we can't attribute to a single file).
  const verifyFn = wrapVerifyFnWithAudit(
    options.verifyFn ?? makeVerifyFn(options.verifyAdapters),
    audit,
  );
  const baselineFiles = [...scope.controllerJs, ...scope.viewXml, ...scope.qunitTest];
  // V1.9 TS-V1-FW — the never-build firewall, site 1 of 2. A TS run NEVER builds
  // a karma baseline probe: karma-running a `.ts` would transpile it via the
  // project's `babel.config.js` (arbitrary code execution). The TS baseline is
  // static (ui5lint + config-gated eslint) via `lintProbe` below.
  const karmaProbe =
    projectLanguage !== 'ts' && scope.qunitTest.length > 0
      ? async () => {
          const r = await verifyFn({
            projectRoot: options.projectRoot,
            // ui5lint requires a file; pass the first qunit test file as the
            // ui5lint target. We only care about the karma step's outcome
            // here, but verifyArtifact runs ui5lint first. If ui5lint fails
            // on a test file it's already a per-file baseline finding from
            // pass 1, so we tolerate it.
            file: scope.qunitTest[0] ?? options.projectRoot,
            eslintEnabled: false,
            testFiles: scope.qunitTest,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          });
          return r.failedStep === 'karma'
            ? { ok: false, stderr: r.feedbackForLlm }
            : { ok: true, stderr: '' };
        }
      : undefined;
  // V1.3.1-3: the baseline lint pass is batched (O(1) lint subprocesses, see
  // `runBaselineLint`). When an integration test injects verify stubs
  // (`verifyAdapters` / `verifyFn`) the per-file verify pipeline drives the
  // baseline instead — preserving the exact per-file `Finding` attribution
  // those tests assert — while production uses the batched path.
  const baselineTestMode =
    options.verifyFn !== undefined || options.verifyAdapters !== undefined;
  const lintProbe = makeBaselineLintProbe({
    projectRoot: options.projectRoot,
    files: baselineFiles,
    eslintEnabled,
    // V1.9 G2-03 — widen the batched baseline eslint scope to `.ts` only when
    // the project is TS and ships a TS-aware eslint config (`eslintEnabled`
    // already encodes that gate).
    ...(projectLanguage === 'ts' && eslintEnabled ? { tsEslint: true } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(baselineTestMode ? { perFileVerifyFn: verifyFn } : {}),
  });
  const baselineResult = await collectBaselineFindings({
    lintProbe,
    ...(karmaProbe !== undefined ? { karmaProbe } : {}),
  });
  if (baselineResult.unattributable.length > 0) {
    return finish({
      exitReason: { kind: 'baseline-failed' },
      exitCode: 1,
    });
  }

  // 6b. V1.4-4 — proactive `baseline-unpreloaded-libs` check (deterministic,
  //     no LLM). Run after the existing baseline phase passes; emit
  //     findings against `webapp/manifest.json` for every unpreloaded
  //     gap. When `--auto-apply-baseline-fixes` is set, write the
  //     patched manifest directly (mechanical fix; no LLM call burned);
  //     otherwise the finding rides through to the report and contributes
  //     to the `unfixed-findings` non-zero exit. The check skips the
  //     standard `applyAndVerifyFix` pipeline entirely — the fix is
  //     deterministic and there is no LLM proposal to verify.
  // R2.2 (AUDIT §5.1) — byte-exact pre-fix snapshot of every file this run
  // applies a fix to, keyed by resolved absolute path. First write wins: a
  // second fix applied on top of the same file must still revert to the
  // content the USER had, not to the first fix. Feeds the post-fix suite
  // gate's revert-all below. Declared OUTSIDE the TS gate below — the
  // apply-and-verify loop (step 8) and the post-fix suite gate (step 9) both
  // consume it unconditionally.
  const appliedFixSnapshots = new Map<string, string>();

  // `unpreloadedFindings` / `unpreloadedFixApplied` are likewise declared
  // OUTSIDE the TS gate: the downstream report surfacing and the
  // `unpreloadedUnfixed` exit-accounting (step 8) read them unconditionally.
  // For a TS run they stay empty (the gate below never populates them).
  const unpreloadedFindings: Finding[] = [];
  let unpreloadedFixApplied = false;
  // V1.9.1 (D1/D2) — the `baseline-unpreloaded-libs` check is a karma-ui5
  // PRELOAD-hang prediction ("…will hang at karma's browserNoActivityTimeout").
  // The never-build firewall guarantees a TS run NEVER executes karma — the two
  // karma sites (the baseline probe at step 6 and the post-fix suite at step 9)
  // are both gated `projectLanguage !== 'ts'` — so the predicted failure is
  // structurally unreachable for TS. Running the check anyway forced a permanent
  // exit-1 with no path to exit 0 (V1.9.1-DIAGNOSIS D1/D2). Gate it off for TS,
  // mirroring those two karma sites; skip the graph build too — with no karma
  // lane to protect there is nothing to fix, so its CDN probe is needless on a
  // TS run. (`generate` refuses TS before this point; Fix B (D3) still corrects
  // the JS path's exclusion.)
  if (projectLanguage !== 'ts') {
    const projectGraph = await buildProjectGraph({
      projectRoot: options.projectRoot,
      testLayout: layout,
      projectLanguage,
      ...(options.probeLib !== undefined ? { probeLib: options.probeLib } : {}),
    });
    if (projectGraph.unpreloadedLibs.length > 0) {
      const checkResult = checkUnpreloadedLibs({
        projectRoot: options.projectRoot,
        projectGraph,
      });
      unpreloadedFindings.push(...checkResult.findings);
      if (options.autoApplyBaselineFixes === true) {
        const fixable = checkResult.findings.find((f) => f.proposedFix !== null);
        if (fixable !== undefined && fixable.proposedFix !== null) {
          const manifestAbs = join(options.projectRoot, 'webapp', 'manifest.json');
          // v0.8.1 V1: the path components are constant, but `webapp/` itself
          // can be a link out of the tree — same realpath assert as every
          // other write site.
          await assertInsideProject(manifestAbs, options.projectRoot);
          // R2.2: the mechanical manifest fix participates in revert-all too —
          // a wrong preload entry is itself a karma-hang candidate (AUDIT §5.5),
          // so a red suite restores the exact baseline-verified tree.
          const manifestOriginal = await readFile(manifestAbs, 'utf8');
          await writeFile(manifestAbs, fixable.proposedFix.newFileContent, 'utf8');
          appliedFixSnapshots.set(resolve(manifestAbs), manifestOriginal);
          unpreloadedFixApplied = true;
        }
      }
    }
  }

  // 7. Run check loop (SPEC §2.8)
  // V1.9.7 (THR-2) — one pool-wide rate-limit signal per run, created only when
  // the batch phase will actually run concurrently (K>1). Shared by every batch
  // worker via ctx; undefined on the sequential path keeps that path
  // byte-identical (the withRateLimitBackoff signal + the claim-loop gate both
  // no-op when unset). Mirrors generate.ts's `effectiveConcurrency > 1` guard.
  // `checkConcurrency` was resolved near the top (for the budget menu); record
  // the effective width on the report now the check phase is actually running.
  report.concurrency = checkConcurrency;
  const rateLimitSignal = checkConcurrency > 1 ? new RateLimitSignal() : undefined;
  const ctx: CheckContext = {
    projectRoot: options.projectRoot,
    runner,
    budget,
    testLayout: layout,
    capState,
    // V1.9 GA1-10 — gates the TS-aware check prompt framing (```typescript
    // fence + ES-module/class fix guidance + the TS system prompt).
    projectLanguage,
    // V1.9.4 PERF-17 — forward the resolved per-run model to every check call.
    ...(model !== undefined ? { model } : {}),
    // V1.9.7 THR-2 — the batch-phase pool's rate-limit signal (K>1 only).
    ...(rateLimitSignal !== undefined ? { rateLimitSignal } : {}),
    // V1.9.8 — cache-key components + the store itself (undefined when
    // --cache is off, keeping the batch dispatch byte-identical to today).
    ...(report.claudeVersion !== undefined ? { claudeVersion: report.claudeVersion } : {}),
    ...(detectionCache !== undefined ? { detectionCache } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  // V1.9.1 (Fix C / I4) — `missing-test-coverage` runs only over the coverage
  // triage's mapped controllers; the unmapped ones are surfaced via the
  // rolled-up finding below (no LLM call).
  const targetSets = buildCheckTargetSets(
    scope,
    options.projectRoot,
    coverageTriage.mapped,
  );
  // V1.9.4 PERF-2/8 — the 3 controller checks and the 2 view checks are
  // dispatched as ONE LLM call per file (the batch phase below: 3N→N controllers,
  // 2M→M views), NOT once-per-check via the loop. The loop runs only the
  // non-batched checks (missing-teardown, manifest-component-drift). The 5 batched
  // checks stay in `CHECKS` (registry/estimator unchanged); they are only excluded
  // from the loop's target sets here.
  const loopTargetSets = targetSets.filter((s) => !BATCHED_CHECK_IDS.has(s.check.id));

  let batchResult: BatchPhaseResult;
  let loopResult: CheckLoopResult;
  try {
    batchResult = await runCheckBatches({
      ctx,
      controllers: scope.controllerJs,
      // The coverage triage's mapped subset (absolute paths, ⊆ scope.controllerJs)
      // — only these controllers carry `missing-test-coverage` in their batch.
      coverageMapped: new Set(coverageTriage.mapped),
      views: scope.viewXml,
      // V1.9.7 THR-2 — bounded batch-dispatch width (default 1 = sequential).
      concurrency: checkConcurrency,
    });
    // Skip the remaining loop checks when the batch phase already terminated the
    // run (a rate-limit window is hot, or the global budget is spent) — mirrors
    // how runCheckLoop halts once either signal fires.
    loopResult =
      batchResult.rateLimitExhausted !== null || batchResult.budgetExhausted
        ? EMPTY_CHECK_LOOP_RESULT
        : await runCheckLoop(loopTargetSets, ctx);
  } catch (err) {
    // TR-2 (V1.9.6): an envelope-contract mismatch is a systemic CLI-drift signal
    // — every call fails identically, so it surfaces here on the FIRST check call.
    // Finalise with the version-named exit reason (the version is on `report` from
    // the availability probe) rather than letting it fall through to the generic
    // `{ kind: 'error' }` emergency path in cli.ts (which would not name it).
    if (err instanceof ClaudeEnvelopeContractError) {
      return finish({
        exitReason: {
          kind: 'envelope-contract-mismatch',
          ...(report.claudeVersion !== undefined ? { version: report.claudeVersion } : {}),
          file: err.errorFilePath,
        },
        exitCode: 1,
      });
    }
    // BudgetExhaustedError is caught inside runCheckBatches / runCheckLoop; it can
    // still escape the boundary when a check throws from outside the call helper's
    // try/catch (e.g. a deterministic budget probe in a future check), so the arm
    // stays as a safety net.
    if (err instanceof BudgetExhaustedError) {
      return finish({
        exitReason: { kind: 'budget-exhausted', calls: err.callsAttempted },
        exitCode: 1,
      });
    }
    throw err;
  }

  // V1.9.4 PERF-2/8 — the combined check-phase outputs (batch + non-batched loop).
  const checkFindings: readonly Finding[] = [
    ...batchResult.findings,
    ...loopResult.findings,
  ];
  const checkBudgetExhausted = batchResult.budgetExhausted || loopResult.budgetExhausted;
  const checkRateLimitExhausted =
    batchResult.rateLimitExhausted ?? loopResult.rateLimitExhausted;

  // 8. Apply-and-verify each finding's proposedFix (SPEC §2.10).
  //    Baseline findings (source: 'baseline', proposedFix: null) are
  //    prepended so they're fixed BEFORE semantic check findings — the
  //    project should be lint-clean before the LLM starts proposing
  //    semantic rewrites on top of it.
  const allFindings: readonly Finding[] = [
    ...baselineResult.findings,
    ...checkFindings,
    // V1.9.1 (Fix C / I4) — the deterministic rolled-up coverage finding for
    // sources no in-scope test imports. `proposedFix:null` + source 'check', so
    // it is exit-neutral (skipped by the apply loop, excluded from the
    // unfixed-findings tally) exactly like the per-method findings it replaces.
    ...(coverageTriage.rolledUpFinding !== null ? [coverageTriage.rolledUpFinding] : []),
  ];

  const fileEntries = new Map<string, ReportFileEntry>();
  function entry(file: string): ReportFileEntry {
    let e = fileEntries.get(file);
    if (e === undefined) {
      e = { file, findings: [], appliedFixes: [], revertedFixes: [] };
      fileEntries.set(file, e);
    }
    return e;
  }

  for (const finding of allFindings) {
    const e = entry(finding.file);
    e.findings.push(finding);
  }

  // V1.4-4 — surface unpreloaded-libs findings on the manifest entry. When
  // `--auto-apply-baseline-fixes` is set the fix has already been written
  // directly (no LLM); record an `appliedFixes` entry per fixable finding
  // so report.json reflects what happened. When the flag is off, the
  // finding stays in `findings` only and counts toward the non-zero exit.
  let unpreloadedUnfixed = 0;
  for (const finding of unpreloadedFindings) {
    const e = entry(finding.file);
    e.findings.push(finding);
    if (unpreloadedFixApplied && finding.proposedFix !== null) {
      e.appliedFixes.push({
        checkId: finding.checkId,
        source: finding.source,
      });
    } else {
      unpreloadedUnfixed += 1;
    }
  }

  let revertedAutoFixes = 0;
  let budgetExhaustedDuringFix = false;
  // V1.2-3: pre-seeded from the check loop so a rate-limit that fired
  // during the LLM check phase still preserves any findings collected
  // before the throw — they were just appended to `fileEntries` above —
  // and skips the apply-and-verify phase entirely (the rate-limit window
  // is hot; burning more LLM calls on refinements is pointless).
  let rateLimitDuringFix: RateLimitExhaustedError | null = checkRateLimitExhausted;

  outer: for (const finding of allFindings) {
    if (rateLimitDuringFix !== null) break outer;
    // Skippable: check-source findings with no fix (LLM said "human only").
    // Baseline findings always go through the loop — they have a stderr
    // explanation that bootstraps the initial fix call.
    if (finding.proposedFix === null && finding.source !== 'baseline') continue;
    try {
      // R2.2: capture the pre-fix bytes BEFORE the apply so a red post-fix
      // suite can revert to exactly what the user had. Committed to the
      // snapshot map only on an `applied` outcome (a reverted fix already
      // restored this content itself), and only for the FIRST applied fix
      // per file (a second fix stacks on the first; revert-all must still
      // restore the user's original).
      const fixFileAbs = resolve(
        isAbsolute(finding.file)
          ? finding.file
          : join(options.projectRoot, finding.file),
      );
      const preFixContent = existsSync(fixFileAbs)
        ? await readFile(fixFileAbs, 'utf8')
        : null;
      const outcome = await applyAndVerifyFix({
        finding,
        projectRoot: options.projectRoot,
        runner,
        budget,
        eslintEnabled,
        verifyFn,
        // V1.9 — the per-fix verify takes the TS static lane (ui5lint + tsc +
        // eslint, no karma) for a TS project; `tscEnabled` gates the tsc step.
        projectLanguage,
        tscEnabled,
        // V1.9.4 PERF-17 — forward the resolved per-run model to the fix call.
        ...(model !== undefined ? { model } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      // V1.9.4 PERF-12 — accumulate this fix's byte-capped refinement prompts
      // into the run-level counter (recorded on the report by `finish`).
      contentTruncations += outcome.contentTruncations ?? 0;
      const e = entry(finding.file);
      if (outcome.kind === 'applied') {
        if (preFixContent !== null && !appliedFixSnapshots.has(fixFileAbs)) {
          appliedFixSnapshots.set(fixFileAbs, preFixContent);
        }
        e.appliedFixes.push({ checkId: finding.checkId, source: finding.source });
      } else {
        revertedAutoFixes += 1;
        e.revertedFixes.push({
          checkId: finding.checkId,
          source: finding.source,
          reason: outcome.reason,
        });
      }
    } catch (err) {
      // V1.2-3: RateLimitExhaustedError caught BEFORE BudgetExhaustedError —
      // matches the runCheckLoop catch site above so the two terminal-class
      // signals are prioritised consistently across the orchestrator.
      // applyAndVerifyFix already restored the file before re-throwing.
      if (err instanceof RateLimitExhaustedError) {
        rateLimitDuringFix = err;
        break outer;
      }
      if (err instanceof BudgetExhaustedError) {
        budgetExhaustedDuringFix = true;
        break outer;
      }
      // TR-2 (V1.9.6): defense-in-depth. A systemic contract drift almost always
      // fires in the check phase (it needs zero successful calls to reach the fix
      // phase), but classify it here too. applyAndVerifyFix already reverted this
      // file before re-throwing; earlier accepted fixes stay on disk.
      if (err instanceof ClaudeEnvelopeContractError) {
        return finish({
          exitReason: {
            kind: 'envelope-contract-mismatch',
            ...(report.claudeVersion !== undefined ? { version: report.claudeVersion } : {}),
            file: err.errorFilePath,
          },
          exitCode: 1,
        });
      }
      throw err;
    }
  }

  // 9. R2.2 (AUDIT §5.1) — post-fix suite gate. `generate` verifies every
  //    artifact against karma before accepting it (retry-loop.ts); validate's
  //    per-fix verify omits `testFiles`, so until now every applied fix was
  //    accepted on lint alone — contradicting SPEC §2.10 step 3 and DoD
  //    item 5. Minimum correct version: if any fixes were applied, run the
  //    in-scope qunit suite ONCE; on red, revert ALL applied fixes byte-exact
  //    and record them in `revertedFixes`. Per-fix suite runs (the precise
  //    version, ~1 suite run per fix) stay DEFERRED — this comment is the
  //    SPEC-adjacent record of that deferral. The gate consumes ZERO LLM
  //    budget (it is a karma run) and is bounded to AT MOST ONE suite run
  //    per validate invocation.
  //
  //    The gate is scoped to `scope.qunitTest` — the same files the baseline
  //    karma probe (step 6) proved green before any fix was applied — so a
  //    red gate is attributable to the applied fixes, never to pre-existing
  //    suite redness outside the validated scope.
  let postFixSuite: PostFixSuiteOutcome | undefined;
  let postFixSuiteRevertFailure: string[] | null = null;
  if (projectLanguage === 'ts' && appliedFixSnapshots.size > 0) {
    // V1.9 TS-V1-FW — the never-build firewall, site 2 of 2. A TS run NEVER runs
    // the post-fix karma suite (it would transpile the `.ts` = arbitrary code
    // execution). Each applied fix was already verified statically per-fix
    // (ui5lint + tsc --noEmit + config-gated eslint); the run-level
    // `verification: 'static-only'` marker is the honest record that the test
    // suite was not executed. The gate is recorded `not-run` with that reason.
    postFixSuite = {
      status: 'not-run',
      reason:
        'TypeScript project — fixes are verified statically (ui5lint + tsc --noEmit + eslint); ' +
        'karma is never run for TypeScript (the never-build firewall), so the post-fix test suite is not executed',
    };
  } else if (appliedFixSnapshots.size > 0) {
    if (scope.qunitTest.length === 0) {
      // No qunit tests in scope ⇒ no baseline suite ran either ⇒ a suite run
      // here could not attribute redness to the fixes. Fixes are retained on
      // lint-only verification — the report says so instead of claiming a
      // suite verification that never happened.
      postFixSuite = {
        status: 'not-run',
        reason:
          'no qunit test files in scope — applied fixes are verified by lint only',
      };
      warningStream.write(
        'warning: fixes were applied but no qunit test files are in scope; ' +
          'the post-fix karma suite gate did not run (fixes verified by lint only).\n',
      );
    } else {
      warningStream.write(
        'Running post-fix test suite (karma) — this can take a minute…\n',
      );
      let gate: VerifyResult | null = null;
      try {
        gate = await verifyFn({
          projectRoot: options.projectRoot,
          // verifyArtifact requires a lint target; the first in-scope test
          // file mirrors the baseline karma probe above. Only the karma
          // step's outcome drives the gate — a lint failure on that file is
          // already a per-file baseline finding from step 6.
          file: scope.qunitTest[0] ?? options.projectRoot,
          eslintEnabled: false,
          testFiles: scope.qunitTest,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (err) {
        // A gate that EXPLODED (adapter throw) proves nothing about the
        // fixes. Retain them, report honestly, keep the run alive — the
        // LLM spend and the report must survive a broken runner.
        const msg = err instanceof Error ? err.message : String(err);
        postFixSuite = {
          status: 'not-run',
          reason: `post-fix suite run errored: ${msg}`,
        };
        warningStream.write(
          `warning: the post-fix karma suite gate errored (${msg}); ` +
            'applied fixes are verified by lint only.\n',
        );
      }
      if (gate !== null) {
        if (gate.ok) {
          postFixSuite = { status: 'passed' };
        } else if (gate.failedStep !== 'karma') {
          postFixSuite = {
            status: 'not-run',
            reason: `karma step did not run — ${describeVerifyFailure(gate)}`,
          };
          warningStream.write(
            'warning: the post-fix suite gate stopped before karma ' +
              `(${gate.failedStep ?? 'unknown step'} failed); ` +
              'applied fixes are verified by lint only.\n',
          );
        } else if (karmaRunnerUnavailable(gate)) {
          // Environmental (R2.1(c) already retried a transient blip once
          // inside the pipeline): the runner is down, the fixes are not
          // disproven. Retain + report — never revert on an env failure.
          postFixSuite = {
            status: 'not-run',
            reason: `karma runner unavailable — ${describeVerifyFailure(gate)}`,
          };
          warningStream.write(
            'warning: karma runner unavailable for the post-fix suite gate; ' +
              'applied fixes are verified by lint only.\n',
          );
        } else {
          // Suite red after a green baseline ⇒ the applied fixes broke it.
          // Revert EVERY applied fix to its byte-exact pre-fix content.
          // Best-effort per file: one failing restore must not stop the
          // rest, and is NEVER silent — it lands in `revertFailedFiles`, on
          // stderr, and in the run's error exit below.
          const failureHead = describeVerifyFailure(gate);
          const revertedFiles: string[] = [];
          const revertFailedFiles: string[] = [];
          const revertedAbs = new Set<string>();
          const revertFailedAbs = new Set<string>();
          for (const [abs, original] of appliedFixSnapshots) {
            const rel = toPosix(relative(options.projectRoot, abs));
            try {
              await writeFile(abs, original, 'utf8');
              revertedFiles.push(rel);
              revertedAbs.add(abs);
            } catch (err) {
              revertFailedFiles.push(rel);
              revertFailedAbs.add(abs);
              warningStream.write(
                `warning: post-fix suite failed but reverting ${rel} also ` +
                  `failed (${err instanceof Error ? err.message : String(err)}); ` +
                  'the UNVERIFIED fix is still on disk.\n',
              );
            }
          }
          revertedFiles.sort();
          revertFailedFiles.sort();
          // Re-book the per-file records: fixes on successfully-reverted
          // files move appliedFixes → revertedFixes; fixes on files whose
          // restore failed STAY in appliedFixes (they are, factually, still
          // applied) and are flagged via `revertFailedFiles` + error exit.
          for (const e of fileEntries.values()) {
            const entryAbs = resolve(
              isAbsolute(e.file) ? e.file : join(options.projectRoot, e.file),
            );
            if (!revertedAbs.has(entryAbs)) continue;
            for (const af of e.appliedFixes) {
              revertedAutoFixes += 1;
              e.revertedFixes.push({
                checkId: af.checkId,
                source: af.source,
                reason: `post-fix suite run failed — all applied fixes reverted: ${failureHead}`,
              });
            }
            e.appliedFixes = [];
          }
          postFixSuite = {
            status: 'failed',
            reason: failureHead,
            revertedFiles,
            ...(revertFailedFiles.length > 0 ? { revertFailedFiles } : {}),
          };
          if (revertFailedFiles.length > 0) {
            postFixSuiteRevertFailure = revertFailedFiles;
          }
        }
      }
    }
  }

  const files = [...fileEntries.values()].sort((a, b) => a.file.localeCompare(b.file));

  let exitReason: ExitReason;
  let exitCode: number;
  if (postFixSuiteRevertFailure !== null) {
    // R2.2: a half-reverted tree is the most severe outcome a validate run
    // can leave behind — it outranks every other exit reason so CI and
    // humans cannot miss it.
    exitReason = {
      kind: 'error',
      message:
        'post-fix suite run failed and these files could NOT be reverted ' +
        `(the unverified fix is still on disk): ${postFixSuiteRevertFailure.join(', ')}`,
    };
    exitCode = 1;
  } else if (rateLimitDuringFix !== null) {
    exitReason = {
      kind: 'rate-limited',
      callsCompleted: budget.callsUsed,
      lastError: rateLimitDuringFix.message,
    };
    exitCode = 1;
  } else if (
    budgetExhaustedDuringFix ||
    checkBudgetExhausted ||
    // C2 (V1.5): a per-category cap of 0 short-circuits every semantic check
    // BEFORE budget.consume() (src/checks/_shared.ts), so no
    // BudgetExhaustedError is ever thrown and the run would otherwise fall
    // through to a vacuous `success` having run zero of the seven checks. When
    // there was in-scope work, a budget too small to perform the requested
    // analysis must exit non-zero with the budget reason (SPEC DoD item 9).
    (capState.perCategoryCap === 0 && baselineFiles.length > 0)
  ) {
    exitReason = { kind: 'budget-exhausted', calls: budget.callsUsed };
    exitCode = 1;
  } else if (revertedAutoFixes > 0 || unpreloadedUnfixed > 0) {
    exitReason = {
      kind: 'unfixed-findings',
      remaining: revertedAutoFixes + unpreloadedUnfixed,
    };
    exitCode = 1;
  } else {
    exitReason = { kind: 'success' };
    exitCode = 0;
  }

  return finish({
    files,
    exitReason,
    exitCode,
    ...(postFixSuite !== undefined ? { postFixSuite } : {}),
  });
}

// ---------------------------------------------------------------------------
// File scope resolution

interface ScopeInput {
  readonly projectRoot: string;
  readonly path?: string;
  readonly all: boolean;
  readonly base?: string;
  readonly gitImpl?: GitClient;
  /**
   * V1.9 GA1-01 — source language gate for discovery. Defaults to `'js'`, the
   * byte-identical legacy path; `'ts'` enumerates `.ts`/`.qunit.ts` targets.
   */
  readonly projectLanguage?: ProjectLanguage;
}

interface FileScope {
  readonly controllerJs: readonly string[];
  readonly viewXml: readonly string[];
  readonly qunitTest: readonly string[];
  readonly includesProjectScope: boolean;
}

const GLOB_CONTROLLER_JS = ['webapp/**/*.js'];
const GLOB_VIEW_XML = ['webapp/**/*.view.xml'];
const GLOB_QUNIT_TEST = ['webapp/test/**/*.qunit.js'];
const CONTROLLER_JS_EXCLUDE = ['webapp/test/**', 'webapp/Component.js', 'webapp/Component.ts'];

// V1.9 GA1-01 — TS-aware discovery. A TS-SAPUI5 project ships `.ts` controllers
// and `.qunit.ts` tests instead of `.js`/`.qunit.js`. Ambient declaration files
// (`.d.ts`) and the `Component.ts` entrypoint are not analysis targets — mirror
// of the JS excludes one-for-one so the two lanes stay structurally identical.
const GLOB_CONTROLLER_TS = ['webapp/**/*.ts'];
const GLOB_QUNIT_TEST_TS = ['webapp/test/**/*.qunit.ts'];
const CONTROLLER_TS_EXCLUDE = ['webapp/test/**', 'webapp/Component.ts', 'webapp/**/*.d.ts'];

// Language-gated selectors. `'js'` returns the byte-identical legacy constants,
// so a JS project's discovery is unchanged; only a `'ts'` project takes the new
// branch. The view-XML glob is language-agnostic (XML views are identical in
// JS and TS projects) and is intentionally not parameterized.
function controllerGlobsFor(language: ProjectLanguage): readonly string[] {
  return language === 'ts' ? GLOB_CONTROLLER_TS : GLOB_CONTROLLER_JS;
}
function controllerExcludeFor(language: ProjectLanguage): readonly string[] {
  return language === 'ts' ? CONTROLLER_TS_EXCLUDE : CONTROLLER_JS_EXCLUDE;
}
function qunitGlobsFor(language: ProjectLanguage): readonly string[] {
  return language === 'ts' ? GLOB_QUNIT_TEST_TS : GLOB_QUNIT_TEST;
}

/**
 * V1.1-6 (Bug 4): hard-coded scope-exclusion patterns that drop vendor blobs,
 * minified third-party builds, and pre-bundled outputs from the per-file scope
 * before they reach any check or baseline verify. Applied to all three globs
 * (controller JS, view XML, qunit tests) plus the changed-since-base predicate
 * and explicit-path inputs. V1.2 may surface this list in a config file
 * (SPEC §7); for V1.1 it is intentionally non-configurable.
 */
export const SCOPE_EXCLUDE_GLOBS: readonly string[] = [
  '**/*.min.js',
  '**/*.min.css',
  '**/vendor/**',
  '**/thirdparty/**',
  '**/third-party/**',
  '**/dist/**',
  // E2 (V1.5) — quarantined tests live under webapp/test/_failing/ and are
  // out of scope: they are broken by definition, so running missing-teardown
  // on them only burns LLM/cap budget. Keeps the `--all` glob path in sync
  // with the `isQunitTest` predicate below.
  '**/test/_failing/**',
];

const EXCLUDED_DIR_SEGMENTS = new Set(['vendor', 'thirdparty', 'third-party', 'dist']);

export function isScopeExcluded(rel: string): boolean {
  const r = rel.replace(/\\/g, '/');
  if (r.endsWith('.min.js') || r.endsWith('.min.css')) return true;
  for (const seg of r.split('/')) {
    if (EXCLUDED_DIR_SEGMENTS.has(seg)) return true;
  }
  return false;
}

/**
 * Thrown by {@link resolveFileScope} when the caller passes an explicit path
 * (`--path` / positional arg) that matches the V1.1-6 vendor / minified
 * exclusion list. Bubbles up to the orchestrator, which converts it into an
 * `{ kind: 'error', message }` exit reason (exit code 1).
 *
 * The rejection is intentional: silently treating an explicitly-named vendor
 * blob as in-scope would re-introduce Bug 4 for power users; silently dropping
 * it would surprise the user who literally typed the path. Refusing makes the
 * design intent visible. A future `--force-include` flag (V1.2) is mentioned
 * in the error message for documentation, not implemented in this session.
 */
export class ExcludedPathScopeError extends Error {
  readonly relPath: string;
  constructor(relPath: string) {
    // V1.2-4: lead with the user-relevant framing (this looks like vendor /
    // minified code) and why we skip it (LLM budget), list the patterns so
    // the user can see why this path matched, then point at the planned
    // workaround. The existing scope-exclusion.test.ts assertions pin the
    // substrings `vendor/` and `--force-include` — both retained below.
    super(
      `The path "${relPath}" looks like vendor or minified code, which is excluded from analysis ` +
        `by default to avoid burning LLM budget on third-party assets. ` +
        `Patterns excluded: *.min.js, *.min.css, vendor/, thirdparty/, third-party/, dist/. ` +
        `To analyze it anyway, use --force-include <path> (planned for V1.2+, not yet implemented).`,
    );
    this.name = 'ExcludedPathScopeError';
    this.relPath = relPath;
  }
}

async function resolveFileScope(input: ScopeInput): Promise<FileScope> {
  const language = input.projectLanguage ?? 'js';
  if (input.path !== undefined) {
    const abs = isAbsolute(input.path) ? input.path : resolve(input.projectRoot, input.path);
    const rel = toPosix(relative(input.projectRoot, abs));
    if (isScopeExcluded(rel)) throw new ExcludedPathScopeError(rel);
    return classifySingleFile(rel, abs, input.projectRoot, language);
  }
  if (input.all) return globProject(input.projectRoot, language);

  // Default: changed-since-base. R1.5 (AUDIT §5.6e): on a repo without the
  // requested base, walk the fallback ref chain; only when NO ref resolves
  // does the scope widen to the full project glob — and never silently
  // (CI must see the one-line notice on stderr).
  const opts = input.gitImpl !== undefined ? { gitImpl: input.gitImpl } : {};
  const requestedBase = input.base ?? 'main';
  const resolved = await changedFilesSinceWithFallback(
    input.projectRoot,
    requestedBase,
    opts,
  );
  if (resolved === null) {
    process.stderr.write(
      `[WARN] base ref "${requestedBase}" not found and no fallback ref resolved ` +
        `(tried ${[requestedBase, ...BASE_REF_FALLBACK_CHAIN.filter((r) => r !== requestedBase)].join(', ')}); ` +
        `scope widened to the full project glob.\n`,
    );
    return globProject(input.projectRoot, language);
  }
  if (resolved.baseUsed !== requestedBase) {
    process.stderr.write(
      `[WARN] base ref "${requestedBase}" not found; comparing against ` +
        `"${resolved.baseUsed}" for the changed-files scope.\n`,
    );
  }
  return classifyChangedFiles(resolved.files, input.projectRoot, language);
}

function classifySingleFile(
  rel: string,
  abs: string,
  projectRoot: string,
  language: ProjectLanguage = 'js',
): FileScope {
  if (!existsSync(abs)) {
    return { controllerJs: [], viewXml: [], qunitTest: [], includesProjectScope: false };
  }
  const includesProjectScope = rel === '' || abs === projectRoot;
  if (isQunitTest(rel, language)) return { controllerJs: [], viewXml: [], qunitTest: [abs], includesProjectScope };
  if (isViewXml(rel)) return { controllerJs: [], viewXml: [abs], qunitTest: [], includesProjectScope };
  if (isControllerJs(rel, language)) return { controllerJs: [abs], viewXml: [], qunitTest: [], includesProjectScope };
  return { controllerJs: [], viewXml: [], qunitTest: [], includesProjectScope };
}

async function globProject(
  projectRoot: string,
  language: ProjectLanguage = 'js',
): Promise<FileScope> {
  const [ctrl, view, qunit] = await Promise.all([
    globProjectFiles(controllerGlobsFor(language), {
      cwd: projectRoot,
      ignore: [...controllerExcludeFor(language), ...SCOPE_EXCLUDE_GLOBS],
      absolute: true,
      onlyFiles: true,
    }),
    globProjectFiles(GLOB_VIEW_XML, {
      cwd: projectRoot,
      ignore: [...SCOPE_EXCLUDE_GLOBS],
      absolute: true,
      onlyFiles: true,
    }),
    globProjectFiles(qunitGlobsFor(language), {
      cwd: projectRoot,
      ignore: [...SCOPE_EXCLUDE_GLOBS],
      absolute: true,
      onlyFiles: true,
    }),
  ]);
  return {
    controllerJs: ctrl.sort(),
    viewXml: view.sort(),
    qunitTest: qunit.sort(),
    includesProjectScope: ctrl.length > 0 || view.length > 0,
  };
}

function classifyChangedFiles(
  changed: readonly string[],
  projectRoot: string,
  language: ProjectLanguage = 'js',
): FileScope {
  const controllerJs: string[] = [];
  const viewXml: string[] = [];
  const qunitTest: string[] = [];
  for (const rel of changed) {
    if (isScopeExcluded(rel)) continue;
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    if (isQunitTest(rel, language)) qunitTest.push(abs);
    else if (isViewXml(rel)) viewXml.push(abs);
    else if (isControllerJs(rel, language)) controllerJs.push(abs);
  }
  return {
    controllerJs,
    viewXml,
    qunitTest,
    includesProjectScope: controllerJs.length > 0 || viewXml.length > 0,
  };
}

function isQunitTest(rel: string, language: ProjectLanguage = 'js'): boolean {
  // E2 (V1.5): a quarantined test under webapp/test/_failing/ ends in
  // `.qunit.js`/`.qunit.ts` but must NOT enter scope (broken by definition).
  // This covers the changed-files and single-file paths; `--all` is covered by
  // the `**/test/_failing/**` entry in SCOPE_EXCLUDE_GLOBS.
  if (rel.replace(/\\/g, '/').includes('/test/_failing/')) return false;
  const suffix = language === 'ts' ? '.qunit.ts' : '.qunit.js';
  return rel.startsWith('webapp/test/') && rel.endsWith(suffix);
}
function isViewXml(rel: string): boolean {
  return rel.startsWith('webapp/') && rel.endsWith('.view.xml');
}
function isControllerJs(rel: string, language: ProjectLanguage = 'js'): boolean {
  if (!rel.startsWith('webapp/')) return false;
  if (rel.startsWith('webapp/test/')) return false;
  if (language === 'ts') {
    // V1.9 GA1-01 — TS source scope: any `.ts` under webapp/ except ambient
    // `.d.ts` declarations and the Component.ts entrypoint (mirror of JS).
    if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) return false;
    if (rel === 'webapp/Component.ts') return false;
    return true;
  }
  if (!rel.endsWith('.js')) return false;
  if (rel === 'webapp/Component.js') return false;
  return true;
}
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Target-set mapping per check scope

function buildCheckTargetSets(
  scope: FileScope,
  projectRoot: string,
  // V1.9.1 (Fix C / I4) — the coverage-triage mapped subset for
  // `missing-test-coverage`; every other check uses the full scope.
  coverageMappedControllerJs: readonly string[],
): readonly CheckTargetSet[] {
  const sets: CheckTargetSet[] = [];
  for (const check of CHECKS) {
    const targets = targetsForScope(check, scope, projectRoot, coverageMappedControllerJs);
    if (targets.length === 0) continue;
    sets.push({ check, targets });
  }
  return sets;
}

function targetsForScope(
  check: CheckModule,
  scope: FileScope,
  projectRoot: string,
  coverageMappedControllerJs: readonly string[],
): readonly string[] {
  const s: CheckScope = check.scope;
  switch (s) {
    case 'controller-js':
      // V1.9.1 (Fix C / I4) — `missing-test-coverage` skips controllers no
      // in-scope test imports (rolled up deterministically); every other
      // controller-js check still scans all controllers.
      return check.id === 'missing-test-coverage'
        ? coverageMappedControllerJs
        : scope.controllerJs;
    case 'view-xml':
      return scope.viewXml;
    case 'qunit-test':
      return scope.qunitTest;
    case 'project':
      return scope.includesProjectScope ? [projectRoot] : [];
  }
}

// ---------------------------------------------------------------------------
// Verify factory

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

// ---------------------------------------------------------------------------
// 3-attempt apply-and-verify fix loop (SPEC §2.10)

interface FixContext {
  readonly finding: Finding;
  readonly projectRoot: string;
  readonly runner: ClaudeRunner;
  readonly budget: CallBudget;
  readonly eslintEnabled: boolean;
  readonly verifyFn: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  /**
   * V1.9 — source language. `'ts'` routes the per-fix verify through the
   * static-only lane (ui5lint + tsc + eslint, no karma) and the refinement LLM
   * call through the TS system prompt. Defaults to `'js'` (byte-identical).
   */
  readonly projectLanguage?: ProjectLanguage;
  /** V1.9 — gate the `tsc --noEmit` verify step (project ships its own tsc). */
  readonly tscEnabled?: boolean;
  /**
   * V1.9.4 PERF-17 — resolved per-run model, forwarded onto the refinement
   * `claude -p` call. Unset keeps the call byte-identical to today.
   */
  readonly model?: string;
  readonly signal?: AbortSignal;
  /**
   * Optional override for the SPEC §2.12 backoff sleeps on the refinement
   * LLM path (production leaves it unset → real `setTimeout` via
   * `defaultSleeper`). Exists so the R1.4 backoff witnesses drive the full
   * 1s/4s/16s schedule on an instant recording clock — the real-timer
   * version was load-sensitive under the e2e gate (project memory).
   */
  readonly sleeper?: Sleeper;
}

type FixOutcome =
  | { readonly kind: 'applied'; readonly attempts: number; readonly contentTruncations?: number }
  | {
      readonly kind: 'reverted';
      readonly attempts: number;
      readonly reason: string;
      readonly contentTruncations?: number;
    };

/**
 * Apply a Finding's fix and verify it in up to 3 attempts (SPEC §2.10).
 *
 * Two entry shapes converge on the same loop:
 *
 *  - **Check-originated finding** (`source: 'check'`, `proposedFix` present).
 *    Attempt 1 writes the LLM's initial `newFileContent`. On verify failure
 *    we burn one budget call to ask for a refined `newFileContent`, then
 *    attempt 2, and so on. Failure on the 3rd attempt reverts the file.
 *
 *  - **Baseline finding** (`source: 'baseline'`, `proposedFix: null`,
 *    `explanation` holds the raw verify stderr). We bootstrap an initial
 *    `newFileContent` by feeding the stderr to the LLM via the same
 *    refinement helper (one budget call), then enter the same 3-attempt
 *    loop. From the loop's perspective baseline and check are
 *    indistinguishable.
 *
 * Budget is shared with the check phase. A `BudgetExhaustedError` thrown by
 * the LLM helper restores the original file before propagating.
 */
export async function applyAndVerifyFix(ctx: FixContext): Promise<FixOutcome> {
  const finding = ctx.finding;
  const fileAbs = isAbsolute(finding.file)
    ? finding.file
    : join(ctx.projectRoot, finding.file);
  // R1.1 (AUDIT §5.2) / v0.8.1 V1: defense-in-depth behind the normalizer's
  // file pin — never write outside projectRoot, whatever `finding.file`
  // claims. realpath-based (v0.8.1): the lexical `resolve` comparison this
  // replaces was blind to a symlink/junction under the project. Asserting
  // `fileAbs` once here covers every write in this function — the apply
  // writes and the reverts all target the same unchanged `fileAbs`.
  await assertInsideProject(fileAbs, ctx.projectRoot);
  if (!existsSync(fileAbs)) {
    return { kind: 'reverted', attempts: 0, reason: `target file not found: ${finding.file}` };
  }
  const originalContent = await readFile(fileAbs, 'utf8');

  let nextContent: string;
  let lastFailureReason = '';
  // V1.9.4 PERF-12 — count refinement prompts whose embedded file was byte-capped
  // (the run-level `contentTruncations` the orchestrator sums into `RunReport`).
  let contentTruncations = 0;

  if (finding.proposedFix !== null) {
    nextContent = finding.proposedFix.newFileContent;
  } else if (finding.source === 'baseline') {
    // Bootstrap: ask the LLM for an initial fix using the raw stderr as feedback.
    try {
      const initial = await requestRefinedFix({
        runner: ctx.runner,
        budget: ctx.budget,
        projectRoot: ctx.projectRoot,
        relFile: toPosix(relative(ctx.projectRoot, fileAbs)),
        currentContent: originalContent,
        feedback: finding.explanation,
        ...(ctx.projectLanguage !== undefined ? { language: ctx.projectLanguage } : {}),
        ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(ctx.sleeper !== undefined ? { sleeper: ctx.sleeper } : {}),
      });
      if (initial.contentTruncated) contentTruncations += 1;
      if (initial.content === null) {
        return {
          kind: 'reverted',
          attempts: 0,
          reason: 'LLM did not produce an initial baseline fix',
          ...(contentTruncations > 0 ? { contentTruncations } : {}),
        };
      }
      nextContent = initial.content;
    } catch (err) {
      // V1.2-3: rate-limit-exhausted is run-terminating. Re-throw before any
      // other classifier so the orchestrator can finalise with the dedicated
      // `rate-limited` exit reason. No file revert is required here — the
      // bootstrap runs BEFORE the first `writeFile`, so the on-disk content
      // is still the user's original.
      if (err instanceof RateLimitExhaustedError) throw err;
      if (err instanceof BudgetExhaustedError) throw err;
      if (err instanceof MalformedLlmOutputError) {
        return {
          kind: 'reverted',
          attempts: 0,
          reason: `LLM produced malformed initial baseline fix: ${err.message}`,
        };
      }
      if (err instanceof ClaudeApiError) {
        return {
          kind: 'reverted',
          attempts: 0,
          reason: `Claude API error producing initial baseline fix: ${err.message}`,
        };
      }
      if (err instanceof ClaudeProcessKilledError) {
        // V1.2-2: an oversized / malformed target file can kill the claude
        // subprocess while the baseline bootstrap is still running. Surface
        // it as a reverted fix instead of letting it propagate — otherwise
        // the orchestrator never reaches `finish()` and the per-category
        // cap accounting is lost from `report.json`.
        return {
          kind: 'reverted',
          attempts: 0,
          reason: `Claude process killed while bootstrapping baseline fix (exit ${err.exitCode}): ${err.message}`,
        };
      }
      throw err;
    }
  } else {
    // Check-originated finding with no fix → not auto-fixable, surface as-is.
    return { kind: 'reverted', attempts: 0, reason: 'no proposedFix' };
  }

  // R2.3(ii) (AUDIT §5.4): everything past the first `writeFile` runs under a
  // revert guard. The arms inside the loop already restore `originalContent`
  // for the throw classes they recognise (rate-limit / budget exhaustion),
  // but a throwing verifyFn — or any unanticipated error — escaped with the
  // half-applied fix still on disk. The guard restores the byte-exact
  // original (re-restoring after an inner arm already did is an idempotent
  // same-bytes write) and rethrows the ORIGINAL error. If the restore itself
  // fails, the half-applied file is REPORTED on stderr — never silent — and
  // the original error still propagates unmasked.
  try {
  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt += 1) {
    await writeFile(fileAbs, nextContent, 'utf8');
    const verifyInput: VerifyPipelineInput = {
      projectRoot: ctx.projectRoot,
      file: fileAbs,
      eslintEnabled: ctx.eslintEnabled,
      // V1.9 — a TS fix is verified by the static-only lane (no karma). The JS
      // path omits both (defaults `'js'`), so its verify input is unchanged.
      ...(ctx.projectLanguage !== undefined ? { language: ctx.projectLanguage } : {}),
      ...(ctx.tscEnabled !== undefined ? { tscEnabled: ctx.tscEnabled } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    };
    const verify = await ctx.verifyFn(verifyInput);
    if (verify.ok) {
      return { kind: 'applied', attempts: attempt, ...(contentTruncations > 0 ? { contentTruncations } : {}) };
    }
    lastFailureReason = describeVerifyFailure(verify);

    if (attempt === MAX_FIX_ATTEMPTS) break;

    // Ask the LLM for a refined fix.
    let refined: RefineResult | null;
    try {
      refined = await requestRefinedFix({
        runner: ctx.runner,
        budget: ctx.budget,
        projectRoot: ctx.projectRoot,
        relFile: toPosix(relative(ctx.projectRoot, fileAbs)),
        currentContent: nextContent,
        feedback: prepareFeedbackForPrompt(verify.feedbackForLlm).text,
        ...(ctx.projectLanguage !== undefined ? { language: ctx.projectLanguage } : {}),
        ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(ctx.sleeper !== undefined ? { sleeper: ctx.sleeper } : {}),
      });
    } catch (err) {
      // V1.2-3: rate-limit-exhausted unwinds with the same file-revert as
      // the BudgetExhaustedError arm — by this point the loop has written
      // at least one fix attempt, so restoring `originalContent` keeps the
      // working tree clean before the run terminates via the orchestrator's
      // `rate-limited` exit reason.
      if (err instanceof RateLimitExhaustedError) {
        await writeFile(fileAbs, originalContent, 'utf8');
        throw err;
      }
      if (err instanceof BudgetExhaustedError) {
        await writeFile(fileAbs, originalContent, 'utf8');
        throw err;
      }
      if (err instanceof MalformedLlmOutputError) {
        refined = null;
        lastFailureReason = `LLM produced malformed refinement output: ${err.message}`;
      } else if (err instanceof ClaudeApiError) {
        refined = null;
        lastFailureReason = `Claude API error during refinement: ${err.message}`;
      } else if (err instanceof ClaudeProcessKilledError) {
        // V1.2-2: same rationale as the baseline-bootstrap case above —
        // do not let a process kill abort the entire run when the cap or
        // a remaining baseline finding could still produce useful work.
        refined = null;
        lastFailureReason = `Claude process killed during refinement (exit ${err.exitCode}): ${err.message}`;
      } else {
        throw err;
      }
    }
    if (refined === null) break;
    if (refined.contentTruncated) contentTruncations += 1;
    if (refined.content === null) break;
    nextContent = refined.content;
  }

  await writeFile(fileAbs, originalContent, 'utf8');
  return {
    kind: 'reverted',
    attempts: MAX_FIX_ATTEMPTS,
    reason: lastFailureReason || 'verification failed after 3 attempts',
    ...(contentTruncations > 0 ? { contentTruncations } : {}),
  };
  } catch (err) {
    try {
      await writeFile(fileAbs, originalContent, 'utf8');
    } catch (restoreErr) {
      process.stderr.write(
        `[WARN] could not restore original content of ${finding.file} after a ` +
          `fix-loop error — the unverified fix attempt may still be on disk: ` +
          `${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
      );
    }
    throw err;
  }
}

/**
 * V1.2-2: convert the cap state's skipped counters into a `cappedChecks`
 * override for the report. Returns an empty object when nothing was
 * skipped — keeps `cappedChecks` absent from reports the cap never
 * affected, matching the "least disruption" goal in V1.2-PLAN.md.
 */
function cappedChecksOverride(
  capState: CategoryCapState | undefined,
): Partial<Pick<RunReport, 'cappedChecks'>> {
  if (capState === undefined) return {};
  const skipped = getSkippedCounts(capState);
  if (Object.keys(skipped).length === 0) return {};
  return { cappedChecks: skipped };
}

function describeVerifyFailure(v: VerifyResult): string {
  if (v.failedStep === undefined) return v.feedbackForLlm;
  const head = v.feedbackForLlm.split('\n').slice(0, 4).join('\n');
  return `${v.failedStep} failed: ${head}`;
}

interface RefineInput {
  readonly runner: ClaudeRunner;
  readonly budget: CallBudget;
  readonly projectRoot: string;
  readonly relFile: string;
  readonly currentContent: string;
  readonly feedback: string;
  /**
   * V1.9 — source language for the refinement system prompt. `'ts'` uses the
   * TS-framed prompt (ES-module/class, never `sap.ui.define`); defaults `'js'`.
   */
  readonly language?: ProjectLanguage;
  /** V1.9.4 PERF-17 — user-selected model; forwarded to `buildClaudeArgs`. */
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** Test seam for the backoff sleeps — see {@link FixContext.sleeper}. */
  readonly sleeper?: Sleeper;
}

/**
 * Result of one refinement call. `content` is the parsed `newFileContent`, or
 * `null` when the LLM output was unparseable (the caller treats null as a failed
 * attempt). `contentTruncated` reports whether the embedded file was byte-capped
 * (PERF-12) — surfaced even on a `null` content so the run's `contentTruncations`
 * count is faithful regardless of how the call resolved.
 */
interface RefineResult {
  readonly content: string | null;
  readonly contentTruncated: boolean;
}

async function requestRefinedFix(input: RefineInput): Promise<RefineResult> {
  input.budget.consume();
  // V1.9.4 (PERF-12) — byte-cap the embedded file. Post-TR-1 the prompt is on
  // stdin, so this is a token-cost bound (not the old `CLAUDE_ARGV_LIMIT` argv
  // guard): a large source file re-sent uncached across up to MAX_FIX_ATTEMPTS
  // retries would inflate input tokens for no gain. Files at/under the cap
  // embed byte-identically; only an oversized file is run through the same
  // `prepareFeedbackForPrompt` machinery and flagged so the model returns the
  // corrected FULL file rather than the partial view it is shown. The
  // revert-on-failure guard below still catches a bad partial.
  let embeddedContent = input.currentContent;
  let contentTruncatedBytes = 0;
  if (Buffer.byteLength(input.currentContent, 'utf8') > REFINE_CONTENT_CAP_BYTES) {
    const capped = prepareFeedbackForPrompt(input.currentContent, REFINE_CONTENT_CAP_BYTES);
    embeddedContent = capped.text;
    contentTruncatedBytes = capped.truncatedBytes;
  }
  const contentTruncated = contentTruncatedBytes > 0;
  if (contentTruncated) {
    // `contentTruncations` is surfaced as a per-occurrence [WARN] line, mirroring
    // the `[WARN] refinement feedback truncated …` precedent (retry-loop.ts).
    process.stderr.write(
      `[WARN] refinement content truncated ${contentTruncatedBytes} bytes ` +
        `(cap ${REFINE_CONTENT_CAP_BYTES} bytes) — model asked to return the FULL corrected file\n`,
    );
  }
  const prompt = [
    'Your previous fix for the following file did not pass verification.',
    '',
    `File: ${input.relFile}`,
    '```',
    embeddedContent,
    '```',
    ...(contentTruncated
      ? [
          '',
          'NOTE: the file content above was TRUNCATED to fit the prompt budget — it is a',
          'PARTIAL view, not the whole file. Return the corrected COMPLETE file (every',
          'original line, with your fix applied), never a patch or only the part shown.',
        ]
      : []),
    '',
    'Verification output (raw):',
    '```',
    input.feedback,
    '```',
    '',
    'Return ONLY a single JSON object of the shape:',
    '{ "newFileContent": "<corrected full file content>" }',
    'No prose, no markdown fences.',
  ].join('\n');
  const args = buildClaudeArgs({
    prompt,
    // V1.9 — TS refinement uses the TS-framed system prompt (never steers an
    // ES-module file toward `sap.ui.define`). JS is byte-identical.
    systemPrompt: systemPromptFor(input.language ?? 'js'),
    cwd: input.projectRoot,
    // V1.9.4 PERF-17 — forward the user-selected model when set.
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const result = await withRateLimitBackoff(() => input.runner.run(args), {
    isRateLimited: isRateLimitedResult,
    ...(input.sleeper !== undefined ? { sleeper: input.sleeper } : {}),
    // R1.4 (AUDIT §5.6d): the real `claude -p` surfaces a 429 as a THROWN
    // ClaudeApiError, not a returned result — without these two handlers a
    // transient 429 mid-fix bypassed backoff and landed as a reverted fix +
    // exit 1, the exact inversion D1 fixed on the other two LLM paths. All
    // three validate call sites now share the identical 429 policy.
    isRateLimitedError: isRateLimitedApiError,
    throwOnExhaustionError: rateLimitExhaustedFromError,
    // V1.2-3: a rate-limit-exhausted refinement is a terminal signal, not a
    // per-fix failure. Throw upward; `applyAndVerifyFix`'s catch arm reverts
    // the file before re-throwing so the orchestrator's `rate-limited` exit
    // reason is reached without leaving a half-written file on disk.
    throwOnExhaustion: (r) =>
      new RateLimitExhaustedError(
        r.callId,
        RATE_LIMIT_BACKOFF_MS.length + 1,
        describeRateLimitedResult(r),
      ),
  });
  const parsed = safeJson(result.raw, refinedSchema);
  return { content: parsed.ok ? parsed.data.newFileContent : null, contentTruncated };
}

const refinedSchema: z.ZodType<{ newFileContent: string }> = fixProposalSchema;

// ---------------------------------------------------------------------------
// Exports re-used by tests

export {
  buildCheckTargetSets,
  classifyChangedFiles,
  classifySingleFile,
  describeVerifyFailure,
  resolveFileScope,
};
export type { FileScope, FixContext, FixOutcome, ScopeInput };

