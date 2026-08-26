/**
 * SPEC §2.10 per-artifact verification pipeline.
 *
 * Sequence:
 *   1. ui5lint on the target file.
 *   2. eslint on the target file (skipped when `eslintEnabled === false`).
 *   3. karma against affected test file(s) (skipped when `testFiles` empty).
 *
 * Each step is recorded on the result. The first failure short-circuits the
 * pipeline: subsequent steps are not run, and the failing step's raw stderr +
 * stdout become `feedbackForLlm`. This string is the pipeline-level
 * contract used to feed errors back to the LLM and to populate the on-disk
 * audit trail at `last-run/verify/`. Kept raw and unmodified at this layer.
 * The prompt-construction layer (`src/generation/retry-loop.ts`,
 * `src/commands/validate.ts`) caps the substituted feedback at
 * `MAX_PROMPT_FEEDBACK_BYTES` via `prepareFeedbackForPrompt` to bound its
 * (uncacheable, re-sent-per-retry) input-token cost; that cap does NOT
 * propagate back here. See `src/util/prompt-feedback.ts`.
 *
 * Adapters are injected so unit tests can supply deterministic results
 * without touching real ui5lint/eslint/karma binaries.
 */

import type { ProjectLanguage } from '../project/detect.js';
import { runUi5Lint, type Ui5LintRunArgs, type Ui5LintResult } from './ui5lint.js';
import { runEslint, type EslintRunArgs, type EslintResult } from './eslint.js';
import { runTsc, type TscRunArgs, type TscResult } from './tsc.js';
import {
  classifyKarmaFailure,
  hasTransientNetworkEvidence,
  KARMA_TIMEOUT_MS,
  runKarma,
  type KarmaRunArgs,
  type KarmaResult,
} from './karma.js';

// V1.9 — `'tsc'` is the TypeScript static lane's type-check step. It NEVER
// co-occurs with `'karma'`: the JS lane runs ui5lint→eslint→karma; the TS lane
// runs ui5lint→tsc→eslint and has NO karma branch (the never-build firewall).
export type VerifyStep = 'ui5lint' | 'eslint' | 'karma' | 'tsc';

/**
 * V1.3-5 adds `'runner-unavailable'`: the karma step failed because the test
 * runner itself could not run (config error, missing plugin/launcher, dead
 * browser), as opposed to a test that ran and failed. The distinction lives
 * entirely on the karma step's status — `VerifyResult.ok`/`failedStep` are
 * unchanged, so `validate` reverts a fix on a broken karma exactly as before.
 */
export type VerifyStepStatus =
  | 'passed'
  | 'failed'
  | 'runner-unavailable'
  // V1.3.3-3 (AM2) — karma launched successfully, the browser launched,
  // but a UI5 module dependency failed to load (project karma-config
  // gap). Routed to a per-test quarantine on first occurrence
  // (V1.3.3-5). Identity-stub witnesses pin the pipeline surface.
  | 'module-load-failure'
  | 'skipped';

export interface VerifyStepResult {
  readonly step: VerifyStep;
  readonly status: VerifyStepStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly skipReason?: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly steps: readonly VerifyStepResult[];
  readonly failedStep?: VerifyStep;
  /** Raw stderr + stdout from the failing step. Empty when `ok`. */
  readonly feedbackForLlm: string;
}

export interface VerifyAdapters {
  readonly ui5lint?: (args: Ui5LintRunArgs) => Promise<Ui5LintResult>;
  readonly eslint?: (args: EslintRunArgs) => Promise<EslintResult>;
  readonly karma?: (args: KarmaRunArgs) => Promise<KarmaResult>;
  /** V1.9 — `tsc --noEmit` adapter for the TypeScript static verify lane. */
  readonly tsc?: (args: TscRunArgs) => Promise<TscResult>;
}

export interface VerifyPipelineInput {
  readonly projectRoot: string;
  /** File just written by the CLI; ui5lint and eslint both target this path. */
  readonly file: string;
  /**
   * Test file(s) affected by the write. When empty/undefined, karma is
   * skipped with reason "no-test-files". The orchestrator decides whether
   * that is acceptable (validate vs generate, OPA5 fallback per §2.10).
   * Ignored entirely on the TS lane — karma is never run for TypeScript.
   */
  readonly testFiles?: readonly string[];
  /** False to skip eslint (e.g., not configured / no TS-aware eslint config). */
  readonly eslintEnabled: boolean;
  /** Optional karma config override (JS lane only). */
  readonly karmaConfig?: string;
  /**
   * V1.9 — the source language. `'ts'` takes the **static-only** verify lane
   * (ui5lint → tsc → eslint), which structurally has NO karma step (the
   * never-build firewall — karma-running a `.ts` would transpile it via the
   * project's babel config = arbitrary code execution). Defaults to `'js'`,
   * the byte-identical legacy lane (ui5lint → eslint → karma).
   */
  readonly language?: ProjectLanguage;
  /**
   * V1.9 — whether to run the `tsc --noEmit` step on the TS lane (true only
   * when the project ships its own `typescript`). When false the step is
   * skipped (ui5lint still type-checks the `.ts`). Ignored on the JS lane.
   */
  readonly tscEnabled?: boolean;
  readonly signal?: AbortSignal;
  readonly adapters?: VerifyAdapters;
}

const ESLINT_SKIP_REASON = 'eslint not configured — see SPEC §2.10 step 2.';
const KARMA_SKIP_REASON = 'no affected test files — karma step skipped.';
const TSC_SKIP_REASON =
  'tsc not available (project ships no typescript) — ui5lint covers type-aware linting.';

export async function verifyArtifact(input: VerifyPipelineInput): Promise<VerifyResult> {
  const ui5lintImpl = input.adapters?.ui5lint ?? runUi5Lint;
  const eslintImpl = input.adapters?.eslint ?? runEslint;
  const karmaImpl = input.adapters?.karma ?? runKarma;

  const steps: VerifyStepResult[] = [];

  // Step 1: ui5lint (required).
  const ui5 = await ui5lintImpl({
    projectRoot: input.projectRoot,
    file: input.file,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  steps.push({
    step: 'ui5lint',
    status: ui5.ok ? 'passed' : 'failed',
    stdout: ui5.stdout,
    stderr: ui5.stderr,
    exitCode: ui5.exitCode,
    durationMs: ui5.durationMs,
  });
  if (!ui5.ok) {
    return failed('ui5lint', steps, ui5.stderr, ui5.stdout);
  }

  // V1.9 TS-V1-FW — the never-build firewall. A TypeScript artifact takes the
  // STATIC-ONLY lane (tsc --noEmit + config-gated eslint) and returns here:
  // there is no `karma` branch below it by construction, so a TS verify can
  // never reach `runKarma`/`ui5 build` and thus never transpile the untrusted
  // project's `babel.config.js` (the TS-V1 arbitrary-code-execution boundary).
  if ((input.language ?? 'js') === 'ts') {
    return verifyStaticTsLane(input, steps);
  }

  // Step 2: eslint (optional).
  if (!input.eslintEnabled) {
    steps.push(skipStep('eslint', ESLINT_SKIP_REASON));
  } else {
    const es = await eslintImpl({
      projectRoot: input.projectRoot,
      file: input.file,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    steps.push({
      step: 'eslint',
      status: es.ok ? 'passed' : 'failed',
      stdout: es.stdout,
      stderr: es.stderr,
      exitCode: es.exitCode,
      durationMs: es.durationMs,
    });
    if (!es.ok) {
      return failed('eslint', steps, es.stderr, es.stdout);
    }
  }

  // Step 3: karma against the affected test file(s).
  const testFiles = input.testFiles ?? [];
  if (testFiles.length === 0) {
    steps.push(skipStep('karma', KARMA_SKIP_REASON));
    return passed(steps);
  }
  const karmaArgs: KarmaRunArgs = {
    projectRoot: input.projectRoot,
    testFiles,
    // V1.3.1-3 Problem 3: bound the karma subprocess so a hung runner fails
    // the step instead of freezing the run.
    timeoutMs: KARMA_TIMEOUT_MS,
    ...(input.karmaConfig !== undefined ? { configFile: input.karmaConfig } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  let km = await karmaImpl(karmaArgs);
  // R2.1(c) (AUDIT-v0.7.0 §5.3c + live §3.1): transient-network evidence
  // (ENOTFOUND / failed proxy) means the UI5 CDN or DNS blinked, not that
  // the candidate is broken. Re-run karma exactly ONCE — a karma re-run
  // only, never an LLM call, so the retry consumes zero budget. If the
  // retry still fails with transient evidence, the step classifies
  // `runner-unavailable` below (run-level, honest): an environmental blip
  // must never quarantine a candidate (the live cap_try run lost a sound
  // formatter test exactly this way). A retry that fails *differently*
  // (e.g. a genuinely red test once the CDN answers) classifies normally.
  let transientRetried = false;
  if (!km.ok && hasTransientNetworkEvidence(`${km.stdout}\n${km.stderr}`)) {
    process.stderr.write(
      '[WARN] karma verify failed with transient network evidence ' +
        '(ENOTFOUND / failed proxy); re-running karma once.\n',
    );
    transientRetried = true;
    km = await karmaImpl(karmaArgs);
  }
  // V1.3-5: a karma run that failed because the runner itself could not run
  // is recorded with the distinct `runner-unavailable` status so `generate`'s
  // retry loop can abort instead of refining a sound test (see
  // `karmaRunnerUnavailable`). V1.3.3-5 adds `'module-load-failure'` for the
  // post-bootstrap UI5 module-load case so the retry loop can short-circuit
  // with a per-test quarantine (see `karmaModuleLoadFailure`). `ok`/`failedStep`
  // below are unchanged.
  let karmaStatus: VerifyStepStatus;
  if (km.ok) {
    karmaStatus = 'passed';
  } else if (
    transientRetried &&
    hasTransientNetworkEvidence(`${km.stdout}\n${km.stderr}`)
  ) {
    // R2.1(c): second consecutive transient-network failure — the runner's
    // network is genuinely down right now. Run-level, never per-candidate.
    karmaStatus = 'runner-unavailable';
  } else {
    const klass = classifyKarmaFailure(km);
    if (klass === 'runner-unavailable') {
      karmaStatus = 'runner-unavailable';
    } else if (klass === 'module-load-failure') {
      karmaStatus = 'module-load-failure';
    } else {
      karmaStatus = 'failed';
    }
  }
  steps.push({
    step: 'karma',
    status: karmaStatus,
    stdout: km.stdout,
    stderr: km.stderr,
    exitCode: km.exitCode,
    durationMs: km.durationMs,
  });
  if (!km.ok) {
    return failed('karma', steps, km.stderr, km.stdout);
  }
  return passed(steps);
}

/**
 * V1.9 TS-V1-FW — the TypeScript static-only verify lane: `tsc --noEmit`
 * (config-gated) then `eslint` (config-gated). Reached from {@link
 * verifyArtifact} after a clean `ui5lint`, for `language === 'ts'` only.
 *
 * **This function has no `karma`/`ui5 build` step, by construction** — it is
 * the structural form of the never-build firewall. A TS artifact is never
 * browser-executed, so the `TS-V1` arbitrary-code-execution boundary is
 * unreachable for `validate` (a future edit that wanted to karma-run a `.ts`
 * would have to add a karma call here, where this comment is — it is not a
 * runtime `if` that can be slipped past). `steps` already carries the passed
 * `ui5lint` step.
 */
async function verifyStaticTsLane(
  input: VerifyPipelineInput,
  steps: VerifyStepResult[],
): Promise<VerifyResult> {
  const tscImpl = input.adapters?.tsc ?? runTsc;
  const eslintImpl = input.adapters?.eslint ?? runEslint;

  // Step 2 (TS): tsc --noEmit (gated on the project shipping its own tsc).
  if (input.tscEnabled === true) {
    const ts = await tscImpl({
      projectRoot: input.projectRoot,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    steps.push({
      step: 'tsc',
      status: ts.ok ? 'passed' : 'failed',
      stdout: ts.stdout,
      stderr: ts.stderr,
      exitCode: ts.exitCode,
      durationMs: ts.durationMs,
    });
    if (!ts.ok) {
      return failed('tsc', steps, ts.stderr, ts.stdout);
    }
  } else {
    steps.push(skipStep('tsc', TSC_SKIP_REASON));
  }

  // Step 3 (TS): eslint (gated on a TS-aware project eslint config — see
  // baseline-lint G2-02/03). No karma step follows: the firewall.
  if (!input.eslintEnabled) {
    steps.push(skipStep('eslint', ESLINT_SKIP_REASON));
    return passed(steps);
  }
  const es = await eslintImpl({
    projectRoot: input.projectRoot,
    file: input.file,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  steps.push({
    step: 'eslint',
    status: es.ok ? 'passed' : 'failed',
    stdout: es.stdout,
    stderr: es.stderr,
    exitCode: es.exitCode,
    durationMs: es.durationMs,
  });
  if (!es.ok) {
    return failed('eslint', steps, es.stderr, es.stdout);
  }
  return passed(steps);
}

/**
 * V1.3-5 — true when the karma verify step failed because the test runner
 * itself could not run (config error, missing plugin/launcher, browser would
 * not start), as opposed to a test that ran and failed. `generate`'s retry
 * loop reads this to abort the run instead of refining/quarantining a sound
 * test. All karma-output marker logic lives in `classifyKarmaFailure`
 * (karma.ts) — callers never string-match karma output themselves.
 */
export function karmaRunnerUnavailable(result: VerifyResult): boolean {
  return result.steps.some(
    (s) => s.step === 'karma' && s.status === 'runner-unavailable',
  );
}

/**
 * V1.3.3-5 — true when the karma verify step was classified as a
 * post-bootstrap module-load failure (karma launched but a UI5 module
 * dependency failed to load at runtime because the project's
 * `karma.conf.js` `client.libs` does not preload the library). The
 * `generate` retry loop reads this to short-circuit refinement on first
 * occurrence — the LLM cannot fix a project karma-config gap from the
 * test-file side, so the candidate quarantines with
 * `phase: 'module-load'` and an actionable message naming the failed
 * module + suggested `client.libs` entry. Mirrors
 * `karmaRunnerUnavailable`'s shape so the retry-loop composes the two
 * checks symmetrically; all pattern matching lives in
 * `classifyKarmaFailure` (karma.ts) — callers never string-match karma
 * output themselves.
 */
export function karmaModuleLoadFailure(result: VerifyResult): boolean {
  return result.steps.some(
    (s) => s.step === 'karma' && s.status === 'module-load-failure',
  );
}

function skipStep(step: VerifyStep, skipReason: string): VerifyStepResult {
  return {
    step,
    status: 'skipped',
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    skipReason,
  };
}

function passed(steps: readonly VerifyStepResult[]): VerifyResult {
  return { ok: true, steps, feedbackForLlm: '' };
}

function failed(
  step: VerifyStep,
  steps: readonly VerifyStepResult[],
  stderr: string,
  stdout: string,
): VerifyResult {
  return {
    ok: false,
    steps,
    failedStep: step,
    feedbackForLlm: joinFeedback(stderr, stdout),
  };
}

function joinFeedback(stderr: string, stdout: string): string {
  if (stderr.length > 0 && stdout.length > 0) return `${stderr}\n${stdout}`;
  if (stderr.length > 0) return stderr;
  return stdout;
}
