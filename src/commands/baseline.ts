/**
 * SPEC §2.3 baseline collector. Runs lint over the in-scope files BEFORE the
 * LLM check loop, captures any per-file ui5lint/eslint failures, and
 * synthesises Finding records with:
 *   - `source: 'baseline'` (distinct from check-originated findings),
 *   - the SPEC §2.3 sentinel `checkId` (`baseline-ui5lint`, `baseline-eslint`)
 *     reflecting which verify step failed,
 *   - `proposedFix: null` + the rendered lint output in `explanation` so the
 *     orchestrator's existing fix loop can bootstrap an initial fix via the
 *     LLM (see `applyAndVerifyFix` in `validate.ts`).
 *
 * V1.3.1-3: the lint pass is supplied as an injected `lintProbe` — a
 * `() => Promise<BaselineLintResult>`. Production wires the batched
 * `runBaselineLint` (O(1) lint subprocesses, `-f json`); integration tests
 * that stub ui5lint/eslint through `VerifyAdapters` get a per-file probe over
 * the single-file verify pipeline. `makeBaselineLintProbe` builds whichever
 * the caller needs. The collector itself no longer takes a `verifyFn` — the
 * O(N) per-file fan-out it used to drive is gone.
 *
 * Karma is treated specially: it is a project-wide step and can fail for
 * reasons not attributable to any single source file (config errors, missing
 * dependencies). The collector reports such failures as "unattributable" so
 * the orchestrator can abort with the `baseline-failed` exit reason — or, when
 * the probe reports the runner could not start at all (V1.3-6), the
 * `karma-unavailable` exit reason. Per-test-file karma attribution is a V2
 * concern.
 */

import type { BaselineCheckId, Finding } from '../types.js';
import type { ExecImpl } from '../util/exec.js';
import {
  runBaselineLint,
  type BaselineLintFileFailure,
  type BaselineLintResult,
  type BaselineLintStep,
} from '../verify/baseline-lint.js';
import type {
  VerifyPipelineInput,
  VerifyResult,
  VerifyStep,
} from '../verify/pipeline.js';

export interface BaselineCollectorInput {
  /**
   * The baseline lint pass. Run once; returns every per-file ui5lint/eslint
   * failure plus any tool failure that could not be attributed to a file.
   * Build it with {@link makeBaselineLintProbe}.
   */
  readonly lintProbe: () => Promise<BaselineLintResult>;
  /**
   * Optional project-wide karma probe. Run once (not per file) AFTER the lint
   * pass so that a karma config error, a missing dependency, or a genuinely
   * red suite becomes visible as an `unattributable` failure rather than being
   * swallowed.
   *
   * V1.3-6: the probe may report `runnerUnavailable: true` when karma could
   * not start at all (config error, missing launcher/plugin, dead browser),
   * as distinct from a suite that ran and failed. The collector copies that
   * signal onto the matching `unattributable` entry so the orchestrator can
   * route a dead runner to the `karma-unavailable` exit reason rather than
   * `baseline-failed`. The field is optional — `validate`'s probe omits it,
   * and its entries are then treated as not-runner-unavailable.
   */
  readonly karmaProbe?: () => Promise<{
    readonly ok: boolean;
    readonly stderr: string;
    readonly runnerUnavailable?: boolean;
  }>;
}

export interface BaselineCollectorResult {
  readonly findings: readonly Finding[];
  /**
   * Non-empty when a verify step failed in a way the collector could not
   * attribute to a specific source file (e.g., karma config error, a batched
   * lint timeout). The orchestrator surfaces this as the `baseline-failed`
   * exit reason — or, V1.3-6, as `karma-unavailable` when a karma entry
   * carries `runnerUnavailable: true` (karma could not start at all).
   */
  readonly unattributable: readonly {
    readonly step: VerifyStep;
    readonly stderr: string;
    readonly runnerUnavailable?: boolean;
  }[];
}

const STEP_TO_CHECK_ID: Readonly<Record<BaselineLintStep, BaselineCheckId>> = {
  ui5lint: 'baseline-ui5lint',
  eslint: 'baseline-eslint',
};

export async function collectBaselineFindings(
  input: BaselineCollectorInput,
): Promise<BaselineCollectorResult> {
  const findings: Finding[] = [];
  const unattributable: {
    step: VerifyStep;
    stderr: string;
    runnerUnavailable?: boolean;
  }[] = [];

  // Pass 1: batched ui5lint + eslint over the in-scope files. A tool failure
  // (exit-2 config error, timeout, unparseable output) surfaces as an
  // unattributable entry; ordinary per-file lint errors become findings.
  const lint = await input.lintProbe();
  for (const u of lint.unattributable) {
    unattributable.push({ step: u.step, stderr: u.stderr });
  }
  for (const failure of lint.failures) {
    findings.push(toBaselineFinding(failure));
  }

  // Pass 2: project-wide karma probe. Failures here can't be attributed to a
  // single source file (karma runs the whole suite at once), so they become
  // unattributable → orchestrator exits with `baseline-failed`. Skipped when
  // Pass 1 already produced an unattributable tool failure — the run is
  // aborting regardless.
  if (input.karmaProbe !== undefined && unattributable.length === 0) {
    const karma = await input.karmaProbe();
    if (!karma.ok) {
      unattributable.push({
        step: 'karma',
        stderr: karma.stderr,
        // V1.3-6: copy the runner-unavailable signal through faithfully when
        // the probe set it; omit it otherwise (`validate`'s probe never sets
        // it). `exactOptionalPropertyTypes` forbids assigning `undefined`.
        ...(karma.runnerUnavailable !== undefined
          ? { runnerUnavailable: karma.runnerUnavailable }
          : {}),
      });
    }
  }

  return { findings, unattributable };
}

function toBaselineFinding(failure: BaselineLintFileFailure): Finding {
  return {
    checkId: STEP_TO_CHECK_ID[failure.step],
    file: failure.file,
    message: `Pre-existing ${failure.step} failure on ${failure.file}`,
    source: 'baseline',
    proposedFix: null,
    explanation: failure.explanation,
  };
}

// ---------------------------------------------------------------------------
// Baseline-lint probe factory

export interface BaselineLintProbeInput {
  readonly projectRoot: string;
  /** In-scope files (absolute paths). */
  readonly files: readonly string[];
  readonly eslintEnabled: boolean;
  /**
   * V1.9 G2-03 — widen the batched eslint scope to `.ts` (a TS project with a
   * TS-aware eslint config). Forwarded to {@link runBaselineLint}; ignored by
   * the per-file probe (which lints whatever absolute paths it is handed).
   * Defaults to `false` (JS byte-identical).
   */
  readonly tsEslint?: boolean;
  readonly signal?: AbortSignal;
  /**
   * Witness-A / production-override seam: when set, the batched baseline-lint
   * path runs through this exec impl. Takes precedence over `perFileVerifyFn`.
   */
  readonly batchedExecImpl?: ExecImpl;
  /**
   * Test-compat seam: when set (an integration test injected `verifyAdapters`
   * / `verifyFn`), baseline lint runs per-file through the single-file verify
   * pipeline — the pre-V1.3.1-3 path — so those tests drive the baseline
   * unchanged. Production leaves it unset and the batched path is used.
   */
  readonly perFileVerifyFn?: (input: VerifyPipelineInput) => Promise<VerifyResult>;
}

/**
 * Resolve the baseline-lint probe `collectBaselineFindings` runs. Precedence:
 *   1. `batchedExecImpl` — the batched `-f json` path on an injected exec
 *      (witness A; a production override).
 *   2. `perFileVerifyFn` — the per-file single-file verify pipeline
 *      (integration tests that stub ui5lint/eslint via `VerifyAdapters`).
 *   3. neither — the batched `-f json` path on the real `exec` (production).
 */
export function makeBaselineLintProbe(
  input: BaselineLintProbeInput,
): () => Promise<BaselineLintResult> {
  const { projectRoot, files, eslintEnabled } = input;

  if (input.batchedExecImpl !== undefined) {
    const execImpl = input.batchedExecImpl;
    return () =>
      runBaselineLint({
        projectRoot,
        files,
        eslintEnabled,
        execImpl,
        ...(input.tsEslint !== undefined ? { tsEslint: input.tsEslint } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
  }

  if (input.perFileVerifyFn !== undefined) {
    const verifyFn = input.perFileVerifyFn;
    return () =>
      perFileLintProbe({
        projectRoot,
        files,
        eslintEnabled,
        verifyFn,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
  }

  return () =>
    runBaselineLint({
      projectRoot,
      files,
      eslintEnabled,
      ...(input.tsEslint !== undefined ? { tsEslint: input.tsEslint } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
}

/**
 * The pre-V1.3.1-3 per-file baseline lint: one `verifyArtifact` call per
 * in-scope file. Reached only when an integration test injects verify stubs;
 * production uses the batched `runBaselineLint`. It preserves the exact
 * single-file contract those tests depend on — `feedbackForLlm` flows verbatim
 * into `explanation`, one finding per first-failing step per file.
 */
async function perFileLintProbe(input: {
  readonly projectRoot: string;
  readonly files: readonly string[];
  readonly eslintEnabled: boolean;
  readonly verifyFn: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  readonly signal?: AbortSignal;
}): Promise<BaselineLintResult> {
  const failures: BaselineLintFileFailure[] = [];
  for (const fileAbs of input.files) {
    const result = await input.verifyFn({
      projectRoot: input.projectRoot,
      file: fileAbs,
      eslintEnabled: input.eslintEnabled,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (result.ok) continue;
    const step = result.failedStep;
    // The per-file probe passes no `testFiles`, so `verifyArtifact` skips
    // karma — `failedStep` is only ever ui5lint / eslint here.
    if (step === 'ui5lint' || step === 'eslint') {
      failures.push({
        file: toProjectRelative(fileAbs, input.projectRoot),
        step,
        explanation: result.feedbackForLlm,
      });
    }
  }
  return { failures, unattributable: [] };
}

function toProjectRelative(abs: string, projectRoot: string): string {
  let p = abs.replace(/\\/g, '/');
  const root = projectRoot.replace(/\\/g, '/');
  if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  return p;
}
