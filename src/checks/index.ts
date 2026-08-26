/**
 * Single source of truth for the SPEC §2.8 V1 check list. The orchestrator
 * (Session 8) iterates this registry; no check is "discovered" by file path.
 *
 * Ordering matters: deterministic, single-file controller checks come
 * before view-level ones; multi-file (`proposedFix: null`) checks run last
 * so when the budget gets thin we still produce the highest-value auto-fix
 * findings first.
 */

import type { CheckId } from '../types.js';
import { BudgetExhaustedError } from '../claude/budget.js';
import { RateLimitExhaustedError } from '../claude/binary-runner.js';
import type { Finding } from '../types.js';
import { globalsInViewsCheck } from './globals-in-views.js';
import { manifestComponentDriftCheck } from './manifest-component-drift.js';
import { missingI18nCheck } from './missing-i18n.js';
import { missingTeardownCheck } from './missing-teardown.js';
import { missingTestCoverageCheck } from './missing-test-coverage.js';
import { noDirectDomCheck } from './no-direct-dom.js';
import { noSyncOdataCheck } from './no-sync-odata.js';
import type { CheckContext, CheckModule, CheckScope } from './types.js';

export const CHECKS: readonly CheckModule[] = Object.freeze([
  noDirectDomCheck,
  noSyncOdataCheck,
  missingTeardownCheck,
  missingI18nCheck,
  globalsInViewsCheck,
  manifestComponentDriftCheck,
  missingTestCoverageCheck,
]);

export function checksByScope(scope: CheckScope): readonly CheckModule[] {
  return CHECKS.filter((c) => c.scope === scope);
}

export function checkById(id: CheckId): CheckModule | undefined {
  return CHECKS.find((c) => c.id === id);
}

export interface CheckTargetSet {
  readonly check: CheckModule;
  readonly targets: readonly string[];
}

export type SkipReason = 'budget-exhausted';

export interface CheckSkip {
  readonly checkId: CheckId;
  readonly target: string;
  readonly reason: SkipReason;
}

export interface CheckLoopResult {
  readonly findings: readonly Finding[];
  readonly skipped: readonly CheckSkip[];
  readonly budgetExhausted: boolean;
  /**
   * V1.2-3: set when `callLlmForFindings` rethrows a
   * {@link RateLimitExhaustedError}. The loop catches it (instead of letting
   * it propagate as the BudgetExhaustedError pattern does NOT — the rate
   * limit is run-terminating, not a per-call skip), preserves all findings
   * collected before the throw so the orchestrator can surface them on
   * `report.files`, and signals the terminal state via this field. The
   * orchestrator routes to the dedicated `{ kind: 'rate-limited' }` exit
   * reason when present.
   */
  readonly rateLimitExhausted: RateLimitExhaustedError | null;
}

/**
 * Drive a list of `{check, targets}` pairs sequentially. The reminder for
 * Session 7 is unambiguous: budget exhaustion halts the loop — every
 * remaining target is recorded as `skipped` with reason `budget-exhausted`,
 * and we do NOT retry. The orchestrator inspects `budgetExhausted` to decide
 * the exit code.
 *
 * V1.2-3: a `RateLimitExhaustedError` halts the loop the same way but
 * surfaces via `rateLimitExhausted` instead of `budgetExhausted` so the
 * orchestrator can route to the dedicated `rate-limited` exit reason
 * without losing the findings collected before the throw.
 */
export async function runCheckLoop(
  sets: readonly CheckTargetSet[],
  ctx: CheckContext,
): Promise<CheckLoopResult> {
  const findings: Finding[] = [];
  const skipped: CheckSkip[] = [];
  let budgetExhausted = false;
  let rateLimitExhausted: RateLimitExhaustedError | null = null;

  outer: for (const set of sets) {
    for (const target of set.targets) {
      if (budgetExhausted) {
        skipped.push({ checkId: set.check.id, target, reason: 'budget-exhausted' });
        continue;
      }
      try {
        const r = await set.check.run(target, ctx);
        findings.push(...r.findings);
      } catch (err) {
        if (err instanceof RateLimitExhaustedError) {
          // Halt the loop without scanning the rest. Findings collected up
          // to this point flow into the orchestrator's `report.files` so a
          // rate-limit mid-run does not erase prior progress. Remaining
          // targets are NOT enumerated as skipped — the dedicated
          // `rate-limited` exit reason already conveys "the run was cut
          // short" without per-target noise (matches `budget-exhausted`
          // ergonomics, which only marks targets the loop actually
          // reached after exhaustion).
          rateLimitExhausted = err;
          break outer;
        }
        if (err instanceof BudgetExhaustedError) {
          budgetExhausted = true;
          skipped.push({ checkId: set.check.id, target, reason: 'budget-exhausted' });
          continue;
        }
        throw err;
      }
    }
  }

  return { findings, skipped, budgetExhausted, rateLimitExhausted };
}

export type { CheckContext, CheckModule, CheckScope, CheckResult } from './types.js';
