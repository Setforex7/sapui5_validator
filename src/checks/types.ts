/**
 * Public surface for SPEC §2.8 semantic checks. Each check is a
 * `CheckModule` registered in [src/checks/index.ts](./index.ts). The orchestrator
 * (Session 8) discovers applicable targets per scope and feeds them to
 * `runCheckLoop` along with a single `CheckContext` shared across the run.
 */

import type { CategoryCapState } from '../budget/cap.js';
import type { CallBudget } from '../claude/budget.js';
import type { RateLimitSignal } from '../claude/rate-limit-signal.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { ProjectGraph } from '../project/dependency-graph.js';
import type { ProjectLanguage } from '../project/detect.js';
import type { TestLayout } from '../project/test-layout.js';
import type { CheckId, Finding } from '../types.js';
import type { DetectionCache } from './cache.js';

/**
 * What kind of artifact a check inspects. The orchestrator maps a scope to a
 * list of target paths; for `project`, the target is the project root.
 */
export type CheckScope = 'controller-js' | 'view-xml' | 'qunit-test' | 'project';

export interface CheckContext {
  readonly projectRoot: string;
  readonly runner: ClaudeRunner;
  readonly budget: CallBudget;
  /**
   * Project-wide test layout (SPEC §2.7) for checks that need to know where
   * QUnit / OPA5 tests live (e.g. `missing-test-coverage` resolves expected
   * test paths from `layout.karma`). Optional so unit tests can omit it; the
   * orchestrator always supplies it in production.
   */
  readonly testLayout?: TestLayout;
  /**
   * V1.2-2 per-category call cap. `callLlmForFindings` short-circuits any call
   * for a `CheckId` that has already consumed its share. COR-7: REQUIRED — a
   * missing cap silently re-opened the V1.1 starvation bug (one category eating
   * the whole budget) with no compile signal. Every construction site must
   * supply one; tests that do not need a binding cap pass a no-bind state
   * (`createCapState(100, maxCalls)`).
   */
  readonly capState: CategoryCapState;
  /**
   * V1.4-3 — pre-built project dependency graph (V1.4-4 baseline
   * check consumes this to emit `baseline-unpreloaded-libs`
   * findings). Optional so unit tests can omit it; the orchestrator
   * builds the graph ONCE at the start of the baseline phase and
   * supplies it to every check in production (V1.4-4 wiring, plan
   * §AM5 guarantee).
   */
  readonly projectGraph?: ProjectGraph;
  /**
   * V1.9 GA1-10 — the project's source language, gating the TS-aware prompt
   * framing (the ` ```typescript ` fence + the ES-module/class fix guidance +
   * the TS system prompt). Optional so unit tests can omit it; defaults to
   * `'js'` at every read site, which keeps the JS prompts byte-identical. The
   * orchestrator threads the detected language in production.
   */
  readonly projectLanguage?: ProjectLanguage;
  /**
   * V1.9.4 PERF-17 — optional per-run model override forwarded to every check's
   * `claude -p` call (via `buildClaudeArgs`). Set only when the user supplied
   * `--model` or chose a non-default model at the opt-in menu; unset leaves the
   * call byte-identical to today (the binary picks the model). Never a pinned id.
   */
  readonly model?: string;
  /**
   * V1.9.7 (THR-2/THR-4) — the pool-wide rate-limit signal shared by every
   * worker in a concurrent validate check-batch run (`runCheckBatches`). Set
   * ONLY when the run's `--concurrency > 1`; undefined on the sequential path
   * keeps that path byte-identical. Two halves cooperate: the
   * `runCheckBatches` claim-loop awaits {@link RateLimitSignal.waitUntilClear}
   * before claiming a NEW batch, and `callLlmForFindingsBatch` forwards it to
   * `withRateLimitBackoff` (so a worker's 429 enters the shared backoff window).
   * The net effect drains new dispatch while any peer is backing off, instead of
   * piling K parallel `claude -p` calls onto a hot quota window (each burning
   * its own backoff schedule + budget). Only the batch phase consumes it; the
   * post-batch `runCheckLoop` is sequential, so its calls never signal.
   */
  readonly rateLimitSignal?: RateLimitSignal;
  /**
   * V1.9.8 — the probed `claude --version` (same value stamped on
   * `RunReport.claudeVersion`), threaded in as a cache-key component: the
   * binary's default model can move underneath an unchanged prompt (CA-2).
   * Optional so unit tests can omit it; the key falls back to `'unknown'`.
   */
  readonly claudeVersion?: string;
  /**
   * V1.9.8 — the cross-run detection result cache (`validate --cache`).
   * Undefined when the flag is off (the default), which keeps the batch
   * dispatch byte-identical to the uncached path. Only
   * `callLlmForFindingsBatch` consumes it: a HIT short-circuits ABOVE the
   * runner (no budget, no cap increment, no audit transcript); only
   * successfully parsed batch results are ever written back. Reads are
   * pre-loaded synchronously at run start, so the HIT/MISS branch inserts no
   * `await` into the cap-check → consume → record prelude.
   */
  readonly detectionCache?: DetectionCache;
  readonly signal?: AbortSignal;
}

export interface CheckResult {
  readonly findings: readonly Finding[];
}

export interface CheckModule {
  readonly id: CheckId;
  readonly scope: CheckScope;
  /**
   * Run the check against a single target. For file scopes, `target` is an
   * absolute path to the file. For `scope === 'project'`, `target` is the
   * absolute project root. A check that finds nothing returns an empty
   * `findings` array — it does not throw.
   *
   * Budget exhaustion surfaces as a thrown `BudgetExhaustedError` from the
   * shared LLM helper; `runCheckLoop` catches it and marks remaining
   * targets as skipped.
   */
  readonly run: (target: string, ctx: CheckContext) => Promise<CheckResult>;
}
