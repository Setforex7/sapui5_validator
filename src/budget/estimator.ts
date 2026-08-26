/**
 * V1.2-1 (Feature 1, Session V1.2-1) — pure estimator for the number of
 * LLM calls a `validate` run will plausibly need given the resolved file
 * scope.
 *
 * Why this lives outside `src/checks/` and outside `src/claude/budget.ts`:
 *
 *   - `checks/` modules consume the budget but do not own the scope-to-call
 *     mapping; the orchestrator does. Putting the formula next to a single
 *     check would couple the estimate to that check's prompt shape.
 *   - `claude/budget.ts` owns `CallBudget` — a counter, not a planner. The
 *     estimator answers "how much budget should the planner ask the user
 *     for?", which is a different concern.
 *
 * The function is deterministic: same `ScopeShape` → same numbers across
 * runs. The breakdown is keyed by `CheckId` so V1.2-2 (per-category cap)
 * can reuse it without re-deriving anything.
 */

import { CHECKS } from '../checks/index.js';
import type { CheckModule } from '../checks/types.js';
import type { CheckId } from '../types.js';

/**
 * Minimum surface area the estimator needs from a resolved file scope.
 * Matches the shape `resolveFileScope` produces in
 * [src/commands/validate.ts](../commands/validate.ts); kept as a local
 * structural type to avoid importing the orchestrator's private `FileScope`.
 */
export interface ScopeShape {
  readonly controllerJs: readonly string[];
  readonly viewXml: readonly string[];
  readonly qunitTest: readonly string[];
  readonly includesProjectScope: boolean;
  /**
   * V1.9.1 (Fix C / I4) — the subset of `controllerJs` that an in-scope test
   * imports, i.e. the LLM-bound targets for `missing-test-coverage`. The
   * orchestrator computes this with `triageCoverageTargets`; the unmapped
   * controllers triage to ONE deterministic rolled-up finding with 0 LLM calls.
   * When present, the estimator counts ONLY these for that check. ABSENT ⇒
   * legacy behaviour (count all `controllerJs`), so every pre-Fix-C call site
   * and unit test is unchanged.
   */
  readonly coverageMappedControllerJs?: readonly string[];
}

export interface CallEstimate {
  readonly minimum: number;
  readonly recommended: number;
  readonly breakdown: Readonly<Partial<Record<CheckId, number>>>;
  readonly totalFiles: number;
  readonly checkCategories: number;
}

/**
 * SPEC §2.12 safety factor for fix loops + retries (`applyAndVerifyFix`
 * burns up to 2 refinement calls per finding on top of the detection call).
 * 1.5× rounded up is conservative enough to cover the common case where
 * a minority of checks produce findings that need one round of refinement.
 */
const RECOMMENDED_SAFETY_FACTOR = 1.5;

/**
 * Estimate the LLM-call budget a `validate` run will plausibly consume.
 *
 * Formula (deterministic):
 *
 *   - For each registered check, count the number of targets the orchestrator
 *     would dispatch given `scope`. The mapping mirrors `targetsForScope` in
 *     `src/commands/validate.ts`:
 *
 *       scope: 'controller-js' → scope.controllerJs.length
 *       scope: 'view-xml'      → scope.viewXml.length
 *       scope: 'qunit-test'    → scope.qunitTest.length
 *       scope: 'project'       → scope.includesProjectScope ? 1 : 0
 *
 *   - `minimum` = sum of all per-target detection calls (one call per
 *     `{check, target}` pair). This is the floor — the run cannot complete
 *     a full pass over the scope below it.
 *
 *   - `recommended` = ceil(minimum × RECOMMENDED_SAFETY_FACTOR). The factor
 *     covers the fix loop (`applyAndVerifyFix`): each finding consumes up
 *     to 2 refinement calls beyond the original detection call. Assuming
 *     ~one third of detection calls produce a finding that needs one round
 *     of refinement, 1.5× is a usable conservative bound.
 *
 *   - `breakdown` is the per-`CheckId` minimum, so the per-category cap
 *     feature (V1.2-2) can derive a fair share without recomputing.
 *
 *   - Baseline (ui5lint / eslint / karma) calls are not estimated — they
 *     require running the linters to know how many failures will hit the
 *     fix loop, which is outside the scope of a pre-LLM estimate.
 */
export function estimateCallsForScope(scope: ScopeShape): CallEstimate {
  const breakdown: Partial<Record<CheckId, number>> = {};
  let minimum = 0;
  let checkCategories = 0;

  for (const check of CHECKS) {
    const targetCount = countTargets(check, scope);
    if (targetCount === 0) continue;
    breakdown[check.id] = targetCount;
    minimum += targetCount;
    checkCategories += 1;
  }

  const recommended = Math.ceil(minimum * RECOMMENDED_SAFETY_FACTOR);
  const totalFiles =
    scope.controllerJs.length + scope.viewXml.length + scope.qunitTest.length;

  return {
    minimum,
    recommended,
    breakdown,
    totalFiles,
    checkCategories,
  };
}

function countTargets(check: CheckModule, scope: ScopeShape): number {
  switch (check.scope) {
    case 'controller-js':
      // V1.9.1 (Fix C / I4) — `missing-test-coverage` spends an LLM call only on
      // controllers an in-scope test imports; the rest roll up into one
      // deterministic finding (triageCoverageTargets). When the orchestrator
      // supplies the mapped subset, count only it; ABSENT ⇒ legacy behaviour
      // (count all controllerJs). Every OTHER controller-js check still counts
      // all controllers.
      if (
        check.id === 'missing-test-coverage' &&
        scope.coverageMappedControllerJs !== undefined
      ) {
        return scope.coverageMappedControllerJs.length;
      }
      return scope.controllerJs.length;
    case 'view-xml':
      return scope.viewXml.length;
    case 'qunit-test':
      return scope.qunitTest.length;
    case 'project':
      return scope.includesProjectScope ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// V1.3.1-5 — `generate` estimator

/**
 * Sibling of {@link CallEstimate} for the `generate` command.
 *
 * `generate` does not run the check registry, so the check-category-keyed
 * `breakdown` / `checkCategories` fields of `CallEstimate` do not apply. The
 * estimate is keyed instead on the discovered candidate count: each candidate
 * costs one LLM call at minimum (the initial generation) and at most the hard
 * retry cap `MAX_GENERATE_ATTEMPTS` (initial + 2 refinement calls — see the
 * retry loop in `src/generation/retry-loop.ts`).
 *
 * The shape stays structurally assignable to the menu's `EstimateBounds` (it
 * has `minimum` + `recommended`), so it can be passed straight to
 * `promptCallLimitChoice` without an adapter.
 */
export interface GenerateCallEstimate {
  /** Floor — one LLM call per candidate, if every first verify passes. */
  readonly minimum: number;
  /**
   * `ceil(candidates × GENERATE_RECOMMENDED_SAFETY_FACTOR)` — the calibrated
   * median, NOT the theoretical tail. The hard per-candidate retry cap is still
   * `MAX_GENERATE_ATTEMPTS` (3, in `retry-loop.ts`); this is only the budget the
   * menu *recommends*.
   */
  readonly recommended: number;
  /** Total in-scope candidates the generator loop will visit. */
  readonly candidateCount: number;
}

/**
 * V1.9.4 (PERF-14) — the generate budget *recommendation* multiplier.
 *
 * `recommended` used to be `candidates × MAX_GENERATE_ATTEMPTS` (3×), the
 * theoretical worst case where EVERY candidate exhausts all three attempts. That
 * is not the median — most candidates pass on attempt 1 or after a single
 * refinement — so 3× over-fired the interactive budget menu on any project past
 * ~16 candidates under the default 50-call budget. 2× is the calibrated middle
 * ground: enough headroom for the common one-round-of-refinement case without the
 * noisy over-prompt.
 *
 * This decouples the *recommendation* from the *hard cap*: the per-candidate
 * retry ceiling stays `MAX_GENERATE_ATTEMPTS` (3) in `retry-loop.ts`, unchanged.
 * An under-estimate only raises the chance of a mid-run `BudgetExhaustedError`,
 * whose quarantine-on-terminal path (`retry-loop.ts`) loses no content — the
 * last attempt is preserved for human review.
 */
const GENERATE_RECOMMENDED_SAFETY_FACTOR = 2.0;

/**
 * Estimate the LLM-call budget a `generate` run will plausibly consume.
 *
 * `generate` issues one LLM call per candidate to produce the initial test,
 * then up to `MAX_GENERATE_ATTEMPTS - 1` refinement calls when verify fails
 * (`generateAndVerify`). The bounds are therefore:
 *
 *   - `minimum` = candidate count — every candidate's initial generation
 *     passes verify on attempt 1, so no refinement call ever fires.
 *   - `recommended` = `ceil(candidates × GENERATE_RECOMMENDED_SAFETY_FACTOR)` —
 *     the calibrated median spend (PERF-14), not the all-candidates-exhaust-all-
 *     retries tail. The hard 3-attempt cap (`MAX_GENERATE_ATTEMPTS`) is unchanged.
 *
 * QUnit and OPA5 candidates are summed; the caller is responsible for the
 * QUnit-only / `--opa5-only` split — it passes `0` for the bucket the run
 * skips, mirroring the `wantQunit` / `wantOpa5` logic in `runGenerate`.
 */
export function estimateCallsForGenerate(args: {
  readonly qunitCandidates: number;
  readonly opa5Candidates: number;
}): GenerateCallEstimate {
  const candidateCount = args.qunitCandidates + args.opa5Candidates;
  return {
    minimum: candidateCount,
    recommended: Math.ceil(candidateCount * GENERATE_RECOMMENDED_SAFETY_FACTOR),
    candidateCount,
  };
}
