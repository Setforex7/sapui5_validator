/**
 * V1.2-1 (Feature 1, Session V1.2-1) — coverage for the pure
 * `estimateCallsForScope` planner that drives the interactive call-limit
 * menu in `src/commands/validate.ts`.
 *
 * The function is fully deterministic, so every assertion below is an exact
 * numeric expectation derived from the formula documented in the JSDoc:
 *
 *   - controller-js targets feed THREE checks (no-direct-dom, no-sync-odata,
 *     missing-test-coverage),
 *   - view-xml targets feed TWO checks (missing-i18n, globals-in-views),
 *   - qunit-test targets feed ONE check (missing-teardown),
 *   - includesProjectScope adds ONE call for manifest-component-drift.
 *
 * `recommended = ceil(minimum × 1.5)`.
 */

import { describe, expect, test } from 'vitest';
import {
  estimateCallsForGenerate,
  estimateCallsForScope,
  type ScopeShape,
} from '../../src/budget/estimator.js';
import { CHECKS } from '../../src/checks/index.js';
import { MAX_GENERATE_ATTEMPTS } from '../../src/generation/retry-loop.js';

function shape(partial: Partial<ScopeShape>): ScopeShape {
  return {
    controllerJs: partial.controllerJs ?? [],
    viewXml: partial.viewXml ?? [],
    qunitTest: partial.qunitTest ?? [],
    includesProjectScope: partial.includesProjectScope ?? false,
  };
}

describe('estimateCallsForScope — pure planner', () => {
  test('empty scope produces zero everywhere', () => {
    const e = estimateCallsForScope(shape({}));
    expect(e.minimum).toBe(0);
    expect(e.recommended).toBe(0);
    expect(e.breakdown).toEqual({});
    expect(e.totalFiles).toBe(0);
    expect(e.checkCategories).toBe(0);
  });

  test('single controller file → 3 controller-scope checks (+ project drift if includesProjectScope)', () => {
    const e = estimateCallsForScope(
      shape({ controllerJs: ['webapp/controller/Main.controller.js'] }),
    );
    // 3 checks × 1 target = 3
    expect(e.minimum).toBe(3);
    expect(e.recommended).toBe(Math.ceil(3 * 1.5));
    expect(e.breakdown['no-direct-dom']).toBe(1);
    expect(e.breakdown['no-sync-odata']).toBe(1);
    expect(e.breakdown['missing-test-coverage']).toBe(1);
    expect(e.totalFiles).toBe(1);
    expect(e.checkCategories).toBe(3);
  });

  test('mixed scope sums per-check totals', () => {
    const e = estimateCallsForScope(
      shape({
        controllerJs: ['a.controller.js', 'b.controller.js'],
        viewXml: ['x.view.xml'],
        qunitTest: ['t.qunit.js', 'u.qunit.js', 'v.qunit.js'],
        includesProjectScope: true,
      }),
    );
    // controllerJs(2) × 3 checks = 6
    // viewXml(1)      × 2 checks = 2
    // qunitTest(3)    × 1 check  = 3
    // project          × 1 check = 1
    // → minimum = 12
    expect(e.minimum).toBe(12);
    expect(e.recommended).toBe(18);
    expect(e.breakdown['no-direct-dom']).toBe(2);
    expect(e.breakdown['no-sync-odata']).toBe(2);
    expect(e.breakdown['missing-test-coverage']).toBe(2);
    expect(e.breakdown['missing-i18n']).toBe(1);
    expect(e.breakdown['globals-in-views']).toBe(1);
    expect(e.breakdown['missing-teardown']).toBe(3);
    expect(e.breakdown['manifest-component-drift']).toBe(1);
    expect(e.totalFiles).toBe(2 + 1 + 3);
    expect(e.checkCategories).toBe(7);
  });

  test('recommended rounds up — never truncates the safety factor', () => {
    // minimum=1 → 1×1.5 = 1.5 → ceil = 2
    const e = estimateCallsForScope(shape({ controllerJs: ['a.js'] }));
    // controllerJs(1) × 3 checks = 3 → recommended = 5 (ceil 4.5)
    expect(e.minimum).toBe(3);
    expect(e.recommended).toBe(5);
  });

  test('large project scales linearly', () => {
    const controllers = Array.from({ length: 20 }, (_, i) => `c${i}.js`);
    const views = Array.from({ length: 15 }, (_, i) => `v${i}.view.xml`);
    const tests = Array.from({ length: 10 }, (_, i) => `t${i}.qunit.js`);
    const e = estimateCallsForScope(
      shape({
        controllerJs: controllers,
        viewXml: views,
        qunitTest: tests,
        includesProjectScope: true,
      }),
    );
    // 20×3 + 15×2 + 10×1 + 1 = 60 + 30 + 10 + 1 = 101
    expect(e.minimum).toBe(101);
    expect(e.recommended).toBe(Math.ceil(101 * 1.5));
    expect(e.totalFiles).toBe(45);
    expect(e.checkCategories).toBe(7);
  });

  test('Fix C (I4): missing-test-coverage counts only coverageMappedControllerJs when supplied', () => {
    // Three controllers, only one of which an in-scope test imports. The
    // coverage triage maps just that one for the per-method LLM check; the
    // other two roll up into a deterministic finding (0 LLM calls). Reverting
    // the estimator's check-aware branch makes this count 3 → RED.
    const e = estimateCallsForScope({
      ...shape({
        controllerJs: ['a.controller.js', 'b.controller.js', 'c.controller.js'],
      }),
      coverageMappedControllerJs: ['a.controller.js'],
    });
    // missing-test-coverage spends an LLM call only on the mapped source...
    expect(e.breakdown['missing-test-coverage']).toBe(1);
    // ...while every OTHER controller-js check still scans all three controllers.
    expect(e.breakdown['no-direct-dom']).toBe(3);
    expect(e.breakdown['no-sync-odata']).toBe(3);
    // minimum = 3 (no-direct-dom) + 3 (no-sync-odata) + 1 (missing-test-coverage) = 7
    expect(e.minimum).toBe(7);
  });

  test('Fix C (I4): absent coverageMappedControllerJs → legacy count (all controllers)', () => {
    // No mapping supplied (the JS-path no-op gate / any pre-Fix-C call site) ⇒
    // missing-test-coverage counts ALL controllers, exactly as before.
    const e = estimateCallsForScope(shape({ controllerJs: ['a.js', 'b.js'] }));
    expect(e.breakdown['missing-test-coverage']).toBe(2);
  });

  test('project-only scope (no files) still counts manifest-component-drift', () => {
    const e = estimateCallsForScope(shape({ includesProjectScope: true }));
    expect(e.minimum).toBe(1);
    expect(e.recommended).toBe(Math.ceil(1 * 1.5));
    expect(e.breakdown['manifest-component-drift']).toBe(1);
    expect(e.checkCategories).toBe(1);
  });

  test('breakdown only contains keys for checks that actually have targets', () => {
    const e = estimateCallsForScope(shape({ viewXml: ['only.view.xml'] }));
    // Only view-xml-scoped checks should appear; controller and qunit
    // breakdown keys are absent (NOT zero-valued).
    expect(Object.keys(e.breakdown).sort()).toEqual(
      ['globals-in-views', 'missing-i18n'].sort(),
    );
    expect(e.breakdown['no-direct-dom']).toBeUndefined();
    expect(e.breakdown['missing-teardown']).toBeUndefined();
  });

  test('result is deterministic — same input → same output', () => {
    const s = shape({
      controllerJs: ['a.js', 'b.js'],
      viewXml: ['v.view.xml'],
      includesProjectScope: true,
    });
    const a = estimateCallsForScope(s);
    const b = estimateCallsForScope(s);
    expect(a).toEqual(b);
  });

  test('formula matches the check registry — invariant guard for V1.2-2', () => {
    // If a check is added/removed in src/checks/index.ts, this test fails
    // loudly so the per-category cap work in V1.2-2 has a single update point.
    expect(CHECKS.length).toBe(7);
  });
});

/**
 * V1.3.1-5 (Problem 1) — coverage for `estimateCallsForGenerate`, the pure
 * planner that drives the `generate` call-limit menu. `generate`'s cost is
 * keyed on candidate counts, not check categories: one LLM call per candidate
 * minimum.
 *
 * V1.9.4 (PERF-14) re-pins the recommended bound: it was
 * `candidates × MAX_GENERATE_ATTEMPTS` (3×, the all-candidates-exhaust-all-
 * retries tail), and is now `ceil(candidates × GENERATE_RECOMMENDED_SAFETY_FACTOR)`
 * (2×, the calibrated median) so the budget menu stops over-firing. The
 * recommendation is DECOUPLED from the hard retry cap: `MAX_GENERATE_ATTEMPTS`
 * stays 3 (asserted below) — only the menu's recommendation dropped.
 */
const GENERATE_RECOMMENDED_FACTOR = 2;

describe('estimateCallsForGenerate — pure planner', () => {
  test('zero candidates produces zero everywhere', () => {
    const e = estimateCallsForGenerate({ qunitCandidates: 0, opa5Candidates: 0 });
    expect(e.minimum).toBe(0);
    expect(e.recommended).toBe(0);
    expect(e.candidateCount).toBe(0);
  });

  test('QUnit-only: minimum = candidates, recommended = ceil(candidates × 2) (PERF-14)', () => {
    const e = estimateCallsForGenerate({ qunitCandidates: 3, opa5Candidates: 0 });
    expect(e.candidateCount).toBe(3);
    expect(e.minimum).toBe(3);
    expect(e.recommended).toBe(6); // ceil(3 × 2) — was 9 (3 × MAX_GENERATE_ATTEMPTS)
  });

  test('OPA5-only: opa5 candidates count when the QUnit bucket is 0 (--opa5-only split)', () => {
    const e = estimateCallsForGenerate({ qunitCandidates: 0, opa5Candidates: 2 });
    expect(e.candidateCount).toBe(2);
    expect(e.minimum).toBe(2);
    expect(e.recommended).toBe(4); // ceil(2 × 2) — was 6
  });

  test('QUnit and OPA5 candidate counts are summed', () => {
    const e = estimateCallsForGenerate({ qunitCandidates: 3, opa5Candidates: 2 });
    expect(e.candidateCount).toBe(5);
    expect(e.minimum).toBe(5);
    expect(e.recommended).toBe(10); // ceil(5 × 2) — was 15
  });

  test('recommended is exactly ceil(minimum × 2) — the PERF-14 median factor', () => {
    for (const n of [1, 4, 7, 20]) {
      const e = estimateCallsForGenerate({ qunitCandidates: n, opa5Candidates: 0 });
      expect(e.recommended).toBe(Math.ceil(e.minimum * GENERATE_RECOMMENDED_FACTOR));
    }
  });

  test('the recommendation is DECOUPLED from the hard retry cap (still 3)', () => {
    // PERF-14 lowers the *recommendation* factor to 2× but must NOT touch the
    // hard per-candidate retry cap — reverting that decoupling makes this RED.
    expect(MAX_GENERATE_ATTEMPTS).toBe(3);
    const e = estimateCallsForGenerate({ qunitCandidates: 4, opa5Candidates: 0 });
    expect(e.recommended).toBe(8); // 4 × 2, NOT 4 × 3 = 12
    expect(e.recommended).toBeLessThan(e.minimum * MAX_GENERATE_ATTEMPTS);
  });

  test('result is deterministic — same input → same output', () => {
    const input = { qunitCandidates: 4, opa5Candidates: 1 };
    expect(estimateCallsForGenerate(input)).toEqual(estimateCallsForGenerate(input));
  });
});
