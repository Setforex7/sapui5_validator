/**
 * V1.2-2 (Feature 1, Session V1.2-2) — per-category LLM call cap.
 *
 * Why this exists: in the first real run against `cap_try` (V1.1 era) all
 * 50 budgeted LLM calls were consumed by `missing-test-coverage` alone, so
 * the other six checks produced zero findings. The cap enforces a ceiling
 * per `CheckId` so a single dominant category cannot starve the rest.
 *
 * The cap is a *count*, derived once from `--per-check-cap <percent>` and the
 * final `--max-llm-calls` (post the V1.2-1 menu). It is independent from the
 * global {@link CallBudget} counter — a capped category short-circuits inside
 * [src/checks/_shared.ts](../checks/_shared.ts) BEFORE `budget.consume()` is
 * called, so the spared budget remains available to other categories.
 *
 * Skipped attempts are recorded so the orchestrator can surface a
 * `cappedChecks` summary in `report.json` — without this, a capped run would
 * look indistinguishable from "this category had no findings".
 */

import type { CheckId } from '../types.js';

/**
 * V1.2-2 default for `--per-check-cap <percent>`. 35% on the default
 * `--max-llm-calls 50` yields a per-category ceiling of 17 calls, enough
 * for a full single-file pass of every check on a small project while
 * still leaving room for ~3 categories to surface findings if any one
 * of them gets greedy.
 */
export const DEFAULT_PER_CHECK_CAP_PERCENT = 35;

export interface CategoryCapState {
  readonly percentLimit: number;
  readonly totalCallLimit: number;
  readonly perCategoryCap: number;
  readonly consumedByCategory: Partial<Record<CheckId, number>>;
  readonly skippedByCategory: Partial<Record<CheckId, number>>;
}

/**
 * Build a fresh cap state from the user's `--per-check-cap <percent>` and the
 * final per-run call limit. `perCategoryCap` uses `Math.floor` so a percentage
 * that does not divide evenly never gifts an extra call to one category at
 * the expense of strict per-category fairness — matches the V1.2 plan ("35%
 * of 30 = 10, not 10.5").
 *
 * Inputs are validated at the CLI boundary (see `src/cli.ts`); this function
 * trusts the caller for `percentLimit ∈ [1, 100]` and a non-negative
 * `totalCallLimit`.
 */
export function createCapState(
  percentLimit: number,
  totalCallLimit: number,
): CategoryCapState {
  const perCategoryCap = Math.floor((percentLimit * totalCallLimit) / 100);
  return {
    percentLimit,
    totalCallLimit,
    perCategoryCap,
    consumedByCategory: {},
    skippedByCategory: {},
  };
}

/**
 * True when `checkId` has not yet hit its per-category ceiling. The check is
 * cheap (one map lookup); call it directly before each LLM call.
 *
 * `perCategoryCap === 0` always returns false — a pathological combination of
 * `--per-check-cap` and `--max-llm-calls` that disables LLM analysis for every
 * category. The orchestrator emits a startup warning when it detects this.
 */
export function canCallForCategory(
  state: CategoryCapState,
  checkId: CheckId,
): boolean {
  const consumed = state.consumedByCategory[checkId] ?? 0;
  return consumed < state.perCategoryCap;
}

/**
 * Increment the consumed-call counter for `checkId`. Must be called after the
 * LLM call site has decided to proceed (i.e. after `canCallForCategory` came
 * back true). Mutates `state` in place — the only mutating function in this
 * module, per the V1.2-2 plan.
 */
export function recordCallForCategory(
  state: CategoryCapState,
  checkId: CheckId,
): void {
  const consumed = state.consumedByCategory[checkId] ?? 0;
  (state.consumedByCategory as Record<CheckId, number>)[checkId] = consumed + 1;
}

/**
 * Increment the skipped-call counter for `checkId`. Called when
 * `canCallForCategory` returns false so the report can show how many calls
 * the cap displaced for each category. Separate from
 * {@link recordCallForCategory} because the two counts answer different
 * questions ("how much did we spend on X" vs "how much did we refuse to
 * spend on X").
 */
export function recordSkippedForCategory(
  state: CategoryCapState,
  checkId: CheckId,
): void {
  const skipped = state.skippedByCategory[checkId] ?? 0;
  (state.skippedByCategory as Record<CheckId, number>)[checkId] = skipped + 1;
}

/**
 * Snapshot the skipped-call counts as a plain record keyed by `CheckId`.
 * Returned object only contains categories that were actually skipped at
 * least once — absent keys mean "no skips" and serialise to a compact
 * `cappedChecks` field in the report.
 */
export function getSkippedCounts(
  state: CategoryCapState,
): Readonly<Partial<Record<CheckId, number>>> {
  return { ...state.skippedByCategory };
}
