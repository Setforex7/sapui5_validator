/**
 * SPEC §2.10 — 3-attempt generate-and-verify loop for the `generate` command.
 *
 * Symmetric to `applyAndVerifyFix` in [src/commands/validate.ts](../commands/validate.ts)
 * but with `generate`-specific terminal semantics: on the 3rd failure the
 * test file is NOT reverted, it is *quarantined* — moved under
 * `webapp/test/_failing/<Name>.failing.qunit.js` (SPEC §2.10) so a human can
 * inspect the LLM's best attempt. The orchestrator surfaces this as a
 * `quarantined` entry on `report.generatedTests`.
 *
 * Every LLM call goes through `buildClaudeArgs` (CLAUDE.md §1.7 allowlist),
 * is rate-limit-backed by `withRateLimitBackoff`, and decrements the shared
 * `CallBudget`. A `BudgetExhaustedError` propagates out so the orchestrator
 * can short-circuit remaining generators.
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename, relative } from 'node:path';
import {
  ClaudeApiError,
  ClaudeProcessKilledError,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
} from '../claude/binary-runner.js';
import {
  BudgetExhaustedError,
  CallBudget,
  RATE_LIMIT_BACKOFF_MS,
  withRateLimitBackoff,
  type Sleeper,
} from '../claude/budget.js';
import type { RateLimitSignal } from '../claude/rate-limit-signal.js';
import { buildClaudeArgs, type ClaudeRunner } from '../claude/runner.js';
import { Semaphore } from '../util/concurrency.js';
import { assertInsideProject } from '../util/containment.js';
import { isProjectLocal, type ProjectGraph } from '../project/dependency-graph.js';
import type { ProjectLanguage } from '../project/detect.js';
import {
  describeRateLimitedResult,
  isRateLimitedApiError,
  isRateLimitedResult,
  rateLimitExhaustedFromError,
  SYSTEM_PROMPT,
} from '../checks/_shared.js';
import {
  FAILING_TEST_SUFFIX,
  FAILING_TEST_SUFFIX_TS,
  failingTestsDir,
} from '../util/paths.js';
import {
  MAX_PROMPT_FEEDBACK_BYTES,
  prepareFeedbackForPrompt,
} from '../util/prompt-feedback.js';
import { fixProposalSchema, safeJson } from '../util/schema.js';
import { libNameFor } from '../project/lib-namespace.js';
import { extractFailedModule } from '../verify/karma.js';
import {
  karmaModuleLoadFailure,
  karmaRunnerUnavailable,
  type VerifyPipelineInput,
  type VerifyResult,
} from '../verify/pipeline.js';

export const MAX_GENERATE_ATTEMPTS = 3;

export interface GenerateRequest {
  /** Initial prompt sent to the LLM (attempt 1). */
  readonly initialPrompt: string;
  /**
   * Build the refinement prompt for attempt N>1. Receives the previous
   * file content (last write) and the raw verify stderr/stdout so the LLM
   * can correct the test.
   */
  readonly buildRefinementPrompt: (args: {
    readonly previousContent: string;
    readonly verifyFeedback: string;
  }) => string;
  /** Absolute path the generated test file is written to. */
  readonly targetTestFileAbs: string;
  /**
   * V1.3-4 — register the test file with the project's test runner. Called
   * once, after the attempt-1 write and before the first verify, so the
   * existing per-artifact karma run executes the new test (SPEC §1.2 — no
   * extra karma launch). The QUnit generator supplies this; OPA5 leaves it
   * undefined (journey registration is out of V1 scope — SPEC §2.1).
   */
  readonly register?: () => Promise<void>;
  /**
   * V1.3-4 — undo {@link register}. Called from `quarantine` so the broken
   * file moved under `webapp/test/_failing/` is not pulled into the suite.
   */
  readonly unregister?: () => Promise<void>;
  /**
   * V1.9.2 (TG-ACCEPT / HB-VACUOUS, FS-11) — optional content shape gate,
   * supplied by the QUnit generator **for TypeScript only**. The TS static lane
   * accepts on `ui5lint` + `tsc --noEmit` + `eslint`, which prove the
   * `.qunit.ts` type-checks but NOT that it asserts anything — an
   * `assert.ok(true)` (or empty-body) test is tsc-green. So a static-only accept
   * additionally requires this gate to pass. A miss is a *refinable* failure:
   * its reason feeds attempt k+1's prompt and the candidate quarantines after 3
   * attempts (never a silent green). When `undefined` (the JS path / OPA5),
   * acceptance is `verify.ok` alone — byte-identical to the pre-V1.9.2 loop.
   */
  readonly shapeCheck?: (content: string) => ShapeCheckResult;
}

/**
 * V1.9.2 (TG-ACCEPT) — result of {@link GenerateRequest.shapeCheck}. `ok:false`
 * carries the human/LLM-facing reason that the generated test is vacuous, fed
 * into the refinement prompt and surfaced on the quarantine entry.
 */
export type ShapeCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface GenerateContext {
  readonly projectRoot: string;
  readonly runner: ClaudeRunner;
  readonly budget: CallBudget;
  readonly eslintEnabled: boolean;
  readonly verifyFn: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  readonly signal?: AbortSignal;
  /**
   * V1.9.2 (TG-FW) — the source language, mirroring `FixContext.projectLanguage`
   * in `commands/validate.ts`. When `'ts'` it is spread onto the per-attempt
   * verify input as `language: 'ts'`, which routes `verifyArtifact` to the
   * static-only TS lane (ui5lint → tsc → eslint) — structurally NO karma, the
   * never-build firewall (SPEC §2.5/§2.10). `undefined` (the JS / default path)
   * leaves the verify input byte-identical to the pre-V1.9.2 loop. The
   * orchestrator does not populate this yet — the generate TS-guard
   * (`ts-guard.ts:60-63`) still refuses TS until Phase 1; this is the firewall
   * choke point lifting the guard depends on.
   */
  readonly projectLanguage?: ProjectLanguage;
  /**
   * V1.9.2 (TG-FW) — gates the `tsc --noEmit` step on the TS lane (true only
   * when the project ships its own `typescript`); mirrors
   * `FixContext.tscEnabled`. Spread onto the verify input alongside
   * `projectLanguage`; ignored on the JS lane.
   */
  readonly tscEnabled?: boolean;
  /**
   * V1.9.4 PERF-17 — optional per-run model override forwarded to every
   * generate `claude -p` call (initial + refinement, via `buildClaudeArgs` in
   * `requestContent`). Set only when the user supplied `--model` or chose a
   * non-default model at the opt-in menu; unset leaves the call byte-identical
   * to today. Never a pinned id.
   */
  readonly model?: string;
  /**
   * V1.4-3 (AC5) — pre-built project dependency graph threaded so
   * V1.4-6's `buildModuleLoadQuarantineMessage` can read
   * `manifestLibs` / `karmaClientLibs` to discriminate the four
   * quarantine cases (A: lib not in manifest no client.libs; B: in
   * manifest no client.libs; C: not in manifest in client.libs; D:
   * no extractable module). Optional so unit tests can omit it; the
   * orchestrator always populates it in production before
   * `generateAndVerify` is called.
   */
  readonly projectGraph?: ProjectGraph;
  /**
   * V1.6 — the run-wide **verify lane**. When the orchestrator runs candidates
   * concurrently (`--concurrency N>1`), it threads ONE `Semaphore(1)` here so
   * the register→verify→accept critical section (and the unregister/quarantine
   * paths) are mutually exclusive across workers. This guarantees that during
   * any worker's whole-suite karma run, the only registered-but-unverified test
   * is that worker's own — so a concurrent worker's in-progress test can never
   * fail this verify (SPEC §1.2 verify-then-accept). Undefined on the
   * sequential default path (`--concurrency 1`), where no locking is needed and
   * behaviour is byte-identical to the pre-V1.6 loop.
   */
  readonly verifyLane?: Semaphore;
  /**
   * COR-13c — injectable backoff sleeper for the per-call rate-limit retry
   * schedule (SPEC §2.12). Production leaves it unset → the real
   * `defaultSleeper` (1s / 4s / 16s real waits). Tests inject an instant
   * sleeper to drive the still-rate-limited → `throwOnExhaustion` path
   * deterministically without the real wall-clock delays.
   */
  readonly backoffSleeper?: Sleeper;
  /**
   * THR-4 (V1.9.7) — the run-wide pool rate-limit signal, supplied by the
   * orchestrator only on a concurrent run (`--concurrency N>1`), alongside
   * {@link verifyLane}. Forwarded to {@link withRateLimitBackoff} so a 429
   * backoff on this candidate closes the shared window and peer workers stop
   * dispatching new candidates until it clears. Undefined on the sequential
   * default path — a lone worker has no peers to drain, so the backoff schedule
   * is byte-identical to the pre-V1.9.7 loop.
   */
  readonly rateLimitSignal?: RateLimitSignal;
}

export type GenerateOutcome =
  | {
      readonly kind: 'generated';
      readonly testFileRel: string;
      readonly attempts: number;
      readonly refinementTruncations?: number;
    }
  | {
      readonly kind: 'quarantined';
      readonly originalTestFileRel: string;
      readonly quarantinedAtRel: string;
      readonly reason: string;
      readonly attempts: number;
      /**
       * V1.3.3-5 — `'module-load'` joins `'initial'` / `'refinement'` for
       * the karma module-load short-circuit: karma launched but a UI5
       * dependency failed to load because the project's `karma.conf.js`
       * `client.libs` does not preload it. The LLM cannot fix this from
       * the test-file side, so refinement is not attempted; the candidate
       * quarantines on the first verify and `attempts` reflects that.
       */
      readonly phase: 'initial' | 'refinement' | 'module-load';
      readonly refinementTruncations?: number;
    }
  | {
      readonly kind: 'no-output';
      readonly testFileRel: string;
      readonly reason: string;
      readonly phase?: 'initial' | 'refinement';
    }
  | {
      /**
       * V1.3-5 — the karma test runner could not run (config error, missing
       * plugin/launcher, dead browser), so the generated test could not be
       * verified. A terminal abort: the orchestrator stops both generator
       * loops and exits with the `karma-unavailable` reason. The test file is
       * left on disk (unverified) but unregistered from the project's suite
       * — see the V1.3-5 behavior-boundary note. Distinct from the rejected
       * `process-killed` variant: a file *was* written and verify genuinely
       * could not run, so this is not a speculative abstraction.
       */
      readonly kind: 'karma-unavailable';
      readonly testFileRel: string;
      readonly reason: string;
    };

/**
 * R1.2 (AUDIT §5.6a) — typed side channel for "a terminal budget/rate-limit
 * signal interrupted a refinement AFTER attempt-1 content was quarantined".
 * Replaces the old `Object.assign(err, {quarantineInfo})`: the error classes
 * stay free of generation concepts, and readers get a typed lookup instead
 * of an `as`-cast. Absence of an entry means no file was ever written (the
 * terminal signal killed the INITIAL call), so the report must say
 * `no-output`, never fabricate `quarantined`.
 */
export interface TerminalQuarantineInfo {
  readonly originalTestFileRel: string;
  readonly quarantinedAtRel: string;
}

const terminalQuarantineInfo = new WeakMap<object, TerminalQuarantineInfo>();

export function attachTerminalQuarantineInfo(
  err: object,
  info: TerminalQuarantineInfo,
): void {
  terminalQuarantineInfo.set(err, info);
}

export function getTerminalQuarantineInfo(
  err: object,
): TerminalQuarantineInfo | undefined {
  return terminalQuarantineInfo.get(err);
}

export async function generateAndVerify(
  request: GenerateRequest,
  ctx: GenerateContext,
): Promise<GenerateOutcome> {
  const fileAbs = request.targetTestFileAbs;
  // v0.8.1 V2: this path is derived from the project's OWN karma `files:`
  // glob (`resolveQUnitRoot`/`expectedTestPath`), so a hostile `../…` glob —
  // or a link under `webapp/` — could land the generated test outside the
  // project. Assert (realpath-based) BEFORE the LLM call: an escaping target
  // must refuse loudly without burning budget, and `fileAbs` never changes,
  // so this one assert covers the mkdir/write in every attempt below.
  await assertInsideProject(fileAbs, ctx.projectRoot);
  const targetRel = toPosix(relative(ctx.projectRoot, fileAbs));

  let nextContent: string;
  try {
    const initial = await requestContent({
      prompt: request.initialPrompt,
      ctx,
    });
    if (initial === null) {
      return {
        kind: 'no-output',
        testFileRel: targetRel,
        reason: 'LLM produced no parseable initial test content',
      };
    }
    nextContent = initial;
  } catch (err) {
    // Terminal signals (budget / rate-limit exhausted) re-throw so the
    // orchestrator can short-circuit remaining generators; per-call failures
    // degrade to a `no-output` outcome. RateLimit is checked before
    // ClaudeApiError, mirroring `src/checks/_shared.ts`.
    if (err instanceof BudgetExhaustedError) throw err;
    if (err instanceof RateLimitExhaustedError) throw err;
    if (err instanceof MalformedLlmOutputError) {
      return {
        kind: 'no-output',
        testFileRel: targetRel,
        reason: `LLM produced malformed initial test content: ${err.message}`,
        phase: 'initial',
      };
    }
    if (err instanceof ClaudeProcessKilledError) {
      process.stderr.write(
        `[WARN] initial subprocess killed: ${err.message}\n`,
      );
      return {
        kind: 'no-output',
        testFileRel: targetRel,
        reason: `Claude process killed producing initial test content: ${err.message}`,
        phase: 'initial',
      };
    }
    if (err instanceof ClaudeApiError) {
      return {
        kind: 'no-output',
        testFileRel: targetRel,
        reason: `Claude API error producing initial test content: ${err.message}`,
        phase: 'initial',
      };
    }
    throw err;
  }

  let lastFailure = '';
  let refinementTruncations = 0;

  for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
    await mkdir(dirname(fileAbs), { recursive: true });
    await writeFile(fileAbs, nextContent, 'utf8');

    const verifyInput: VerifyPipelineInput = {
      projectRoot: ctx.projectRoot,
      file: fileAbs,
      eslintEnabled: ctx.eslintEnabled,
      testFiles: [fileAbs],
      // V1.9.2 (TG-FW) — carry the language onto the choke point, byte-mirroring
      // the fix loop (`validate.ts:1473-1474`). `language: 'ts'` routes
      // `verifyArtifact` to the static-only lane (no karma); `undefined` (the JS
      // default) leaves this input byte-identical to the pre-V1.9.2 loop. This
      // MUST land before Phase 1 lifts the generate TS-guard, or a TS run would
      // take the JS lane → runKarma → in-process Babel = arbitrary code
      // execution (the HB-FW breach the never-build firewall forbids).
      ...(ctx.projectLanguage !== undefined ? { language: ctx.projectLanguage } : {}),
      ...(ctx.tscEnabled !== undefined ? { tscEnabled: ctx.tscEnabled } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    };
    // V1.3-4: register the test with the project's runner BEFORE the verify
    // step so the per-artifact karma run executes it.
    //
    // V1.6: register + verify run together inside the verify lane (when the
    // orchestrator supplies one for a concurrent run). They MUST be one
    // critical section, AND a FAILED verify must un-register before the lane
    // releases. The full subtlety: this worker's whole-suite karma run executes
    // every *registered* test. A candidate that fails attempt 1 then refines
    // (an LLM call OUTSIDE the lane); if it stayed registered with its failing
    // content during that window, a peer worker's karma would execute it and
    // fail a sound candidate — a SPEC §1.2 verify-then-accept violation. So
    // under the lane we (re)register every attempt and un-register again on a
    // failed verify; the next attempt re-registers. The invariant: OUTSIDE the
    // lane, only *passed* tests are ever registered. On the sequential path
    // (`verifyLane` undefined) this is the original attempt-1-only registration
    // with no churn and no unregister-on-fail — byte-identical to pre-V1.6.
    // R2.3(i) (AUDIT §5.4): the register→verify section must hold the lane
    // invariant on the THROW path too. A production verifyFn can throw (e.g.
    // ui5lint adapter, or — pre-R2.3(iii) — the audit decorator); without the
    // catch the candidate stayed registered-but-unverified while the error
    // unwound: in-flight peers' whole-suite karma runs would execute it
    // (SPEC §1.2 / §2.15 violation) and the registration mutation persisted
    // on disk. Best-effort unregister, then rethrow the ORIGINAL error — an
    // unregister failure must not mask what actually broke. The lane permit
    // itself is safe either way (`Semaphore.run` releases in `finally`).
    const verify = await withVerifyLane(ctx.verifyLane, async () => {
      try {
        if (
          request.register !== undefined &&
          (ctx.verifyLane !== undefined || attempt === 1)
        ) {
          await request.register();
        }
        const v = await ctx.verifyFn(verifyInput);
        if (ctx.verifyLane !== undefined && !v.ok && request.unregister !== undefined) {
          await request.unregister();
        }
        return v;
      } catch (err) {
        if (request.unregister !== undefined) {
          try {
            await request.unregister();
          } catch {
            // Best-effort only: removing a stale entry is idempotent and
            // harmless (see `quarantine`); a failure here leaves the original
            // error as the one that propagates.
          }
        }
        throw err;
      }
    });
    // V1.9.2 (TG-ACCEPT / HB-VACUOUS) — a `tsc`/`ui5lint`/`eslint`-green TS test
    // still must ASSERT something against the controller under test; the static
    // lane cannot catch a vacuous test. The shape gate runs on the just-verified
    // content (TS only — the JS path supplies no `shapeCheck`, so `shape` is
    // `undefined` and acceptance stays `verify.ok` alone, byte-identical to the
    // pre-V1.9.2 loop). A shape miss is a *refinable* failure: it does not
    // return, it falls through to the refine/quarantine path with `shapeFailure`
    // as the LLM feedback — never a silent green.
    let shapeFailure: string | undefined;
    if (verify.ok) {
      const shape = request.shapeCheck?.(nextContent);
      if (shape === undefined || shape.ok) {
        return {
          kind: 'generated',
          testFileRel: targetRel,
          attempts: attempt,
          ...(refinementTruncations > 0 ? { refinementTruncations } : {}),
        };
      }
      shapeFailure = shape.reason;
    }
    // V1.3-5: a karma runner that could not run (config error, missing
    // plugin/launcher, dead browser) is not the generated test's fault.
    // Abort at once — never refine (the next `requestContent` would burn an
    // LLM call against a dead runner) and never quarantine (the test is
    // sound, so it must not get the `_failing/` move or `.failing` suffix).
    // The check sits inside the loop so a karma that dies mid-run (alive on
    // attempt 1, dead on attempt 2/3) is caught too. The test file is left on
    // disk but unregistered, so an unverified test never sits in the runnable
    // karma suite (SPEC §1.2 verify-then-accept).
    if (karmaRunnerUnavailable(verify)) {
      // V1.6: unregister mutates the shared testsuite/karma config, so it runs
      // inside the verify lane too (no-op lock on the sequential path).
      if (request.unregister !== undefined) {
        await withVerifyLane(ctx.verifyLane, () => request.unregister!());
      }
      return {
        kind: 'karma-unavailable',
        testFileRel: targetRel,
        reason: describeFailure(verify),
      };
    }
    // V1.3.3-5: a karma run that launched but failed because a UI5 module
    // dependency did not load (project `karma.conf.js` `client.libs` gap) is
    // not the generated test's fault — the LLM cannot add libraries to the
    // project's karma config from the test-file side. Short-circuit on the
    // first occurrence: quarantine this candidate with `phase: 'module-load'`
    // and an actionable message naming the failed module + suggested lib,
    // then let the orchestrator continue with the remaining candidates
    // (per-test, NOT a whole-run abort). Mirrors the V1.3-5
    // `karmaRunnerUnavailable` shape but reuses the existing `quarantined`
    // outcome variant — no new exit reason, no new outcome kind.
    if (karmaModuleLoadFailure(verify)) {
      const karmaStep = verify.steps.find((s) => s.step === 'karma');
      const combined = karmaStep
        ? `${karmaStep.stdout}\n${karmaStep.stderr}`
        : '';
      const failedModule = extractFailedModule(combined);
      const quarantinedAtRel = await quarantine(
        fileAbs,
        ctx.projectRoot,
        request.unregister,
        ctx.verifyLane,
      );
      return {
        kind: 'quarantined',
        originalTestFileRel: targetRel,
        quarantinedAtRel,
        // V1.4-6 (AC5) — the message builder now reads the project graph
        // to differentiate the four module-load quarantine cases. The
        // legacy `(failedModule, suggestedLib)` shape collapses inside
        // the function: `suggestedLib` is derived via `libNameFor`, and
        // the graph drives which of {A, B, C, D} fires.
        reason: buildModuleLoadQuarantineMessage(failedModule, ctx.projectGraph),
        attempts: attempt,
        phase: 'module-load',
      };
    }
    lastFailure = shapeFailure ?? describeFailure(verify);

    if (attempt === MAX_GENERATE_ATTEMPTS) break;

    let refined: string | null;
    try {
      const { text: bounded, truncatedBytes } = prepareFeedbackForPrompt(
        shapeFailure ?? verify.feedbackForLlm,
      );
      if (truncatedBytes > 0) {
        refinementTruncations += 1;
        process.stderr.write(
          `[WARN] refinement feedback truncated ${truncatedBytes} bytes ` +
            `(cap ${MAX_PROMPT_FEEDBACK_BYTES} bytes)\n`,
        );
      }
      refined = await requestContent({
        prompt: request.buildRefinementPrompt({
          previousContent: nextContent,
          verifyFeedback: bounded,
        }),
        ctx,
      });
    } catch (err) {
      if (
        err instanceof BudgetExhaustedError ||
        err instanceof RateLimitExhaustedError
      ) {
        // Both are terminal signals (budget / rate-limit exhausted).
        // Quarantine immediately so the LLM's last attempt is preserved for
        // human review, then re-throw so the orchestrator can record the
        // budget-exhausted / rate-limited exit reason.
        const quarantinedAtRel = await quarantine(
          fileAbs,
          ctx.projectRoot,
          request.unregister,
          ctx.verifyLane,
        );
        attachTerminalQuarantineInfo(err, {
          originalTestFileRel: targetRel,
          quarantinedAtRel,
        });
        throw err;
      }
      if (err instanceof MalformedLlmOutputError) {
        refined = null;
        lastFailure = `LLM produced malformed refinement: ${err.message}`;
      } else if (err instanceof ClaudeProcessKilledError) {
        // The attempt-1 file is already on disk; `refined === null` breaks the
        // loop and falls through to `quarantine(...)` → `kind: 'quarantined'`.
        process.stderr.write(
          `[WARN] refinement subprocess killed: ${err.message}\n`,
        );
        refined = null;
        lastFailure = `Claude process killed during refinement: ${err.message}`;
      } else if (err instanceof ClaudeApiError) {
        refined = null;
        lastFailure = `Claude API error during refinement: ${err.message}`;
      } else {
        throw err;
      }
    }
    if (refined === null) break;
    nextContent = refined;
  }

  const quarantinedAtRel = await quarantine(
    fileAbs,
    ctx.projectRoot,
    request.unregister,
    ctx.verifyLane,
  );
  return {
    kind: 'quarantined',
    originalTestFileRel: targetRel,
    quarantinedAtRel,
    reason: lastFailure || `verification failed after ${MAX_GENERATE_ATTEMPTS} attempts`,
    attempts: MAX_GENERATE_ATTEMPTS,
    phase: 'refinement',
    ...(refinementTruncations > 0 ? { refinementTruncations } : {}),
  };
}

async function requestContent(input: {
  readonly prompt: string;
  readonly ctx: GenerateContext;
}): Promise<string | null> {
  input.ctx.budget.consume();
  const args = buildClaudeArgs({
    prompt: input.prompt,
    systemPrompt: SYSTEM_PROMPT,
    cwd: input.ctx.projectRoot,
    // V1.9.4 PERF-17 — forward the user-selected model when set; unset keeps the
    // args byte-identical to today.
    ...(input.ctx.model !== undefined ? { model: input.ctx.model } : {}),
    ...(input.ctx.signal !== undefined ? { signal: input.ctx.signal } : {}),
  });
  const result = await withRateLimitBackoff(() => input.ctx.runner.run(args), {
    isRateLimited: isRateLimitedResult,
    // COR-13c: production leaves `backoffSleeper` unset (real SPEC §2.12 waits);
    // tests inject an instant sleeper to drive the exhaustion path fast.
    ...(input.ctx.backoffSleeper !== undefined ? { sleeper: input.ctx.backoffSleeper } : {}),
    // D1 (V1.5): a 429 arrives as a THROWN ClaudeApiError — retry it on the
    // SPEC §2.12 schedule rather than letting it skip backoff and degrade the
    // candidate to no-output on a transient limit.
    isRateLimitedError: isRateLimitedApiError,
    // V1.3-3: a still-rate-limited result after backoff is a terminal signal,
    // not a per-call failure. Throw upward so the orchestrator reaches the
    // `rate-limited` exit reason (same opt-in `validate`'s call sites use).
    throwOnExhaustion: (r) =>
      new RateLimitExhaustedError(
        r.callId,
        RATE_LIMIT_BACKOFF_MS.length + 1,
        describeRateLimitedResult(r),
      ),
    throwOnExhaustionError: rateLimitExhaustedFromError,
    // THR-4 (V1.9.7): forward the pool window so a backoff here drains peer
    // dispatch. Conditional spread — unset on the sequential path keeps the
    // options object byte-identical to the pre-V1.9.7 loop.
    ...(input.ctx.rateLimitSignal !== undefined
      ? { signal: input.ctx.rateLimitSignal }
      : {}),
  });
  const parsed = safeJson(result.raw, fixProposalSchema);
  if (!parsed.ok) return null;
  return parsed.data.newFileContent;
}

/**
 * V1.4-8 (Area B2) — error-signal lines (browser/test exceptions and
 * stack frames) so a buried error reaches `report.json`'s quarantine
 * reason. The cap_try ProductService case showed the failure mode:
 * `joinFeedback` (`src/verify/pipeline.ts`) puts karma stderr (a benign
 * `[DEP0060]` banner + "server started") before stdout (the browser
 * `ERROR`), so a head slice alone captured only the banner and dropped
 * `Uncaught ReferenceError: sinon is not defined`.
 */
const ERROR_SIGNAL_RE =
  /\b(error|failed|failure|exception|not defined|cannot find|is not a function|TypeError|ReferenceError|SyntaxError)\b/i;
const STACK_FRAME_RE = /\s+at\s+\S+:\d+/;
const DESCRIBE_FAILURE_MAX_LINES = 8;

/**
 * Summarise a failed {@link VerifyResult} for the human-facing
 * `report.json` quarantine reason. Keeps the first lines (the common
 * case where the head IS the error) AND appends the first
 * error-signal / stack-frame lines found lower in the output, so an
 * error hidden beneath a benign banner is not lost. Deduplicated and
 * capped at {@link DESCRIBE_FAILURE_MAX_LINES} lines.
 */
export function describeFailure(v: VerifyResult): string {
  if (v.failedStep === undefined) return v.feedbackForLlm;
  const allLines = v.feedbackForLlm.split('\n');
  const selected: string[] = [];
  const pushUnique = (line: string): void => {
    if (selected.length >= DESCRIBE_FAILURE_MAX_LINES) return;
    if (selected.includes(line)) return;
    selected.push(line);
  };
  for (const line of allLines.slice(0, 4)) pushUnique(line);
  for (const line of allLines) {
    if (ERROR_SIGNAL_RE.test(line) || STACK_FRAME_RE.test(line)) {
      pushUnique(line);
    }
  }
  return `${v.failedStep} failed: ${selected.join('\n')}`;
}

/**
 * V1.4-6 — build the actionable quarantine message for a karma
 * module-load failure. Four cases discriminated against the
 * {@link ProjectGraph} so the user sees the *right* remediation rather
 * than a one-size-fits-all `client.libs` hint:
 *
 *   - **Case A** — lib not declared in `manifest.json`,
 *     no `client.libs` override (the cap_try-shape primary case).
 *     Recommends `sapui5-validate --auto-apply-baseline-fixes` and
 *     names the exact manifest entry the user can add by hand.
 *   - **Case B** — lib declared in `manifest.json`, no `client.libs`
 *     override, karma-ui5 still failed to preload it. Most likely a
 *     CDN coverage gap (the configured UI5 CDN does not ship the
 *     library); recommends checking the CDN URL or stubbing the lib
 *     in-test.
 *   - **Case C** — lib NOT in manifest but IS in `client.libs`
 *     override. Uncommon shape — the override is present yet karma-ui5
 *     still failed; likely CDN coverage or karma-ui5 version mismatch.
 *   - **Case D** — the karma stdout did not surface an extractable
 *     `failed to load JavaScript resource: ... - sap.ui.ModuleSystem`
 *     line OR {@link ProjectGraph} is unavailable AND the lib is
 *     underivable. Generic fallback that points at the audit log so the
 *     user can identify the failed module by hand. Since R2.1(a) the
 *     classifier fires only on the ModuleSystem line, so the no-module
 *     branch is defensive (disconnect-alone no longer reaches here — it
 *     classifies `test-failure` and refines instead).
 *
 * Order of discrimination: D (no module) → A (lib underivable OR
 * graph unavailable) → A/B/C cases against the graph. Graceful
 * fallback to Case D when graph + both flags are simultaneously true
 * (structurally improbable — declaring the same lib in BOTH manifest
 * AND `client.libs` is an explicit override).
 *
 * The on-disk audit trail at `.sapui5-validator/last-run/verify/`
 * keeps the raw karma stdout/stderr byte-for-byte (V1.3.3
 * audit-invariant); this helper only shapes the
 * `quarantineReason.message` that surfaces in `report.json`.
 *
 * Snapshot-pinned wording — all four templates are pinned by
 * `test/unit/quarantine-message.test.ts` (one snapshot per case).
 * Drift in any case is an intentional edit.
 */
export function buildModuleLoadQuarantineMessage(
  failedModule: string | null,
  projectGraph: ProjectGraph | undefined,
): string {
  if (failedModule === null) return CASE_D_MESSAGE;
  const lib = libNameFor(failedModule);
  // V1.4-8 (Area A) — own-module guard. When the failed module belongs to
  // the project's own namespace (e.g. `cap_try/controller/Shop`), it is NOT
  // an unpreloaded third-party library: it resolves through the loader's
  // `paths` mapping. Recommending a manifest/client.libs entry for the
  // project's own namespace is wrong. This fires only when no third-party
  // failure preceded it (extractFailedModule returns the first failure in
  // document order, and a genuine unloadable dependency fails before the
  // dependent controller does), so the real-lib cases still reach A/B/C.
  if (
    lib !== null &&
    projectGraph !== undefined &&
    isProjectLocal(lib, projectGraph.projectNamespace)
  ) {
    return buildOwnModuleMessage(failedModule);
  }
  if (lib === null || projectGraph === undefined) {
    return buildCaseAMessage(failedModule, lib);
  }
  const inManifest = projectGraph.manifestLibs.includes(lib);
  const inClientLibs = projectGraph.karmaClientLibs.includes(lib);
  if (!inManifest && !inClientLibs) return buildCaseAMessage(failedModule, lib);
  if (inManifest && !inClientLibs) return buildCaseBMessage(failedModule, lib);
  if (!inManifest && inClientLibs) return buildCaseCMessage(failedModule, lib);
  return CASE_D_MESSAGE;
}

function buildCaseAMessage(
  failedModule: string,
  lib: string | null,
): string {
  if (lib === null) {
    return (
      `karma could not load JavaScript module '${failedModule}' ` +
      `(required by the generated test). The test page hung waiting for ` +
      `the module load and karma's browserNoActivityTimeout fired. The ` +
      `parent library of '${failedModule}' could not be derived from the ` +
      `module ID; add the library that ships '${failedModule}' to ` +
      `webapp/manifest.json's sap.ui5.dependencies.libs section, or ` +
      `re-run with --auto-apply-baseline-fixes once the manifest is ` +
      `corrected. The LLM cannot fix this from the test-file side; ` +
      `further refinement attempts would produce the same failure.`
    );
  }
  return (
    `karma could not load JavaScript module '${failedModule}' ` +
    `(required by the generated test). The library '${lib}' is not ` +
    `declared in webapp/manifest.json's sap.ui5.dependencies.libs ` +
    `section. Run \`sapui5-validate validate --auto-apply-baseline-fixes\` ` +
    `to add it automatically, or add this entry manually:\n` +
    `  "${lib}": {}\n` +
    `under sap.ui5.dependencies.libs in webapp/manifest.json. The LLM ` +
    `cannot fix this from the test-file side; further refinement ` +
    `attempts would produce the same failure.`
  );
}

/**
 * V1.4-8 (Area A) — the failed module is the project's own
 * (`<namespace>/...`), so the load failure is not a missing-library
 * gap. The most common shape (cap_try Shop) is karma resolving the
 * controller's full in-project transitive graph over the remote UI5
 * CDN and exceeding `browserNoActivityTimeout`; the next most common is
 * a genuine load-time error in the controller or one of its in-project
 * imports. The message explicitly steers the user away from adding
 * their own namespace to the manifest / client.libs.
 */
function buildOwnModuleMessage(failedModule: string): string {
  return (
    `karma could not load JavaScript module '${failedModule}' ` +
    `(required by the generated test). This module belongs to the ` +
    `project's own namespace, so it is NOT a missing third-party ` +
    `library — do not add it to webapp/manifest.json or karma.conf.js ` +
    `client.libs. The test page hung waiting for the load and karma's ` +
    `browserNoActivityTimeout fired. The likely cause is that loading ` +
    `'${failedModule}' pulled the controller's full in-project ` +
    `dependency graph over the configured UI5 CDN (see karma.conf.js ` +
    `\`ui5.url\`) and the cumulative load timed out, OR a genuine ` +
    `load-time error in the controller or one of its in-project ` +
    `imports. Check the audit log at ` +
    `.sapui5-validator/last-run/verify/<callId>-karma.txt for the ` +
    `underlying browser error; consider a faster/local UI5 source or ` +
    `a higher browserNoActivityTimeout. The LLM cannot fix a CDN/` +
    `timeout gap from the test-file side; further refinement attempts ` +
    `would produce the same failure.`
  );
}

function buildCaseBMessage(failedModule: string, lib: string): string {
  return (
    `karma could not load JavaScript module '${failedModule}' ` +
    `(required by the generated test). The library '${lib}' IS declared ` +
    `in webapp/manifest.json but failed to load from the configured UI5 ` +
    `CDN (see karma.conf.js \`ui5.url\` — sapui5.hana.ondemand.com vs ` +
    `sdk.openui5.org diverge on enterprise-only libraries). Check ` +
    `whether the CDN supports '${lib}' at the project's UI5 version. If ` +
    `the test environment cannot serve the library, set client.libs in ` +
    `karma.conf.js to override the preload set, or pre-register a stub ` +
    `for '${failedModule}' in the test via ` +
    `sap.ui.define("${failedModule}", [], function () { ... }) before ` +
    `the test module's main sap.ui.define. The LLM cannot fix this ` +
    `from the test-file side; further refinement attempts would produce ` +
    `the same failure.`
  );
}

function buildCaseCMessage(failedModule: string, lib: string): string {
  return (
    `karma could not load JavaScript module '${failedModule}' ` +
    `(required by the generated test). The library '${lib}' is listed ` +
    `in karma.conf.js's client.libs override but failed to load anyway. ` +
    `The most likely cause is CDN coverage — the configured UI5 CDN ` +
    `(per karma.conf.js \`ui5.url\`) may not ship this library at the ` +
    `project's UI5 version — or a karma-ui5 version mismatch. Check ` +
    `the CDN URL in karma.conf.js (sapui5.hana.ondemand.com vs ` +
    `sdk.openui5.org diverge on enterprise-only libraries) and ` +
    `karma-ui5's documented preload behaviour for your installed ` +
    `version. If the test environment cannot serve the library, ` +
    `pre-register a stub for '${failedModule}' in the test via ` +
    `sap.ui.define("${failedModule}", [], function () { ... }) before ` +
    `the test module's main sap.ui.define. The LLM cannot fix this ` +
    `from the test-file side; further refinement attempts would produce ` +
    `the same failure.`
  );
}

const CASE_D_MESSAGE: string =
  `karma could not load a JavaScript module required by the generated ` +
  `test. The test page hung waiting for the module load and karma's ` +
  `browserNoActivityTimeout fired, but the karma output did not surface ` +
  `the specific module ID. Check the audit log at ` +
  `.sapui5-validator/last-run/verify/<callId>-karma.txt for the failed ` +
  `module name and the library that ships it; then either declare the ` +
  `library in webapp/manifest.json's sap.ui5.dependencies.libs section ` +
  `or pre-register a stub for the module in the test. The LLM cannot ` +
  `fix this from the test-file side; further refinement attempts would ` +
  `produce the same failure.`;

/**
 * Move the just-written test file to `webapp/test/_failing/` with a
 * `.failing.qunit.js` suffix. The destination is created on demand. The
 * relative path returned uses POSIX separators so report.json is stable
 * cross-platform. If the source file does not exist (e.g., the LLM never
 * produced parseable content) the function silently returns the destination
 * path so callers can still surface it on the report.
 *
 * V1.3-4: `unregister` (when supplied) drops the test's suite registration so
 * the quarantined file is not pulled into the karma suite. It is called
 * unconditionally — removing a stale entry is correct on every quarantine
 * path (3-failure, budget-exhausted, rate-limit-exhausted) and harmless even
 * if the file move below has already happened or the file was never written.
 */
async function quarantine(
  fileAbs: string,
  projectRoot: string,
  unregister?: () => Promise<void>,
  lane?: Semaphore,
): Promise<string> {
  if (!isAbsolute(fileAbs)) {
    throw new Error(`quarantine expects absolute path, got: ${fileAbs}`);
  }
  // V1.6: the unregister + file move both mutate state shared across concurrent
  // workers (the testsuite/karma registration and the on-disk test file), so
  // the whole body runs inside the verify lane when one is supplied. No-op lock
  // on the sequential default path.
  return withVerifyLane(lane, async () => {
    if (unregister !== undefined) await unregister();
    const destDir = failingTestsDir(projectRoot);
    const baseName = baseWithoutQunit(basename(fileAbs));
    // V1.9.2 (TG-QUARANTINE-TS) — pick the quarantine suffix from the source
    // extension so a `.qunit.ts` lands as `<Name>.failing.qunit.ts`; `.qunit.js`
    // is byte-identical to the pre-V1.9.2 path.
    const suffix = /\.ts$/u.test(fileAbs)
      ? FAILING_TEST_SUFFIX_TS
      : FAILING_TEST_SUFFIX;
    const destAbs = join(destDir, `${baseName}${suffix}`);
    // v0.8.1 V1/V2: the destination is pinned to `webapp/test/_failing/` +
    // `basename()`, but `webapp/` or `test/` can be a link out of the tree —
    // assert before the mkdir creates anything (covers the unlink+rename too,
    // which target the same `destAbs`).
    await assertInsideProject(destAbs, projectRoot);
    await mkdir(destDir, { recursive: true });
    if (existsSync(fileAbs)) {
      // If a previous run already quarantined this name, remove the stale copy
      // so rename doesn't fail on platforms where rename-over-existing throws.
      //
      // R2.3(iv) (AUDIT §5.7d/G9, Windows-real): an AV scanner or indexer
      // holding a transient handle surfaces here as EPERM/EBUSY on the
      // unlink+rename pair; uncaught it aborted the WHOLE run (pool
      // `unexpected` → rethrow, no report entry). Retry the pair once after a
      // short delay; a second failure propagates (a genuinely locked file is
      // not transient).
      try {
        if (existsSync(destAbs)) await unlink(destAbs);
        await rename(fileAbs, destAbs);
      } catch (err) {
        if (!isTransientFsPermissionError(err)) throw err;
        await new Promise<void>((r) => setTimeout(r, QUARANTINE_EPERM_RETRY_DELAY_MS));
        if (existsSync(destAbs)) await unlink(destAbs);
        await rename(fileAbs, destAbs);
      }
    }
    return toPosix(relative(projectRoot, destAbs));
  });
}

/**
 * R2.3(iv) — delay before the single quarantine unlink/rename retry. Long
 * enough for a Windows AV/indexer scan pass to release its handle, short
 * enough not to matter on the run's wall clock.
 */
const QUARANTINE_EPERM_RETRY_DELAY_MS = 100;

/**
 * R2.3(iv) — true for the transient Windows file-lock errno shapes (EPERM
 * from rename-over-scanned-file, EBUSY from an open handle). Anything else —
 * ENOENT, EACCES on a genuinely read-only target — is not retryable.
 */
function isTransientFsPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY';
}

function baseWithoutQunit(name: string): string {
  // V1.9.2 (TG-QUARANTINE-TS) — strip a `.qunit.js` OR `.qunit.ts` suffix (then
  // a bare `.js`/`.ts` defensively). `<Name>.controller.qunit.ts` → `<Name>.controller`,
  // matching the JS derivation exactly (`.controller` is preserved either way).
  return name.replace(/\.qunit\.(?:js|ts)$/u, '').replace(/\.(?:js|ts)$/u, '');
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * V1.6 — run `fn` while holding the run-wide verify lane, or inline when no
 * lane is present (the sequential `--concurrency 1` default). One definition
 * shared by every register/verify/unregister/quarantine site so the optional
 * lock is applied uniformly and a missed site cannot reintroduce a race.
 */
async function withVerifyLane<T>(
  lane: Semaphore | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return lane === undefined ? fn() : lane.run(fn);
}
