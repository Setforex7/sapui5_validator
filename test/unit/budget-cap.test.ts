/**
 * V1.2-2 (Feature 1, Session V1.2-2) — coverage for the pure per-category
 * cap helpers in `src/budget/cap.ts`. The state and helpers are deliberately
 * thin so every assertion is a literal expected value derived from the
 * documented formulas (`floor(percent × total / 100)` for the per-category
 * cap, `<` for the can-call predicate, in-place increment for the recorders).
 */

import { describe, expect, test } from 'vitest';
import {
  canCallForCategory,
  createCapState,
  DEFAULT_PER_CHECK_CAP_PERCENT,
  getSkippedCounts,
  recordCallForCategory,
  recordSkippedForCategory,
} from '../../src/budget/cap.js';

describe('createCapState — per-category cap derivation', () => {
  test('exact 35% of 100 → 35', () => {
    const s = createCapState(35, 100);
    expect(s.perCategoryCap).toBe(35);
    expect(s.percentLimit).toBe(35);
    expect(s.totalCallLimit).toBe(100);
  });

  test('floors to integer — 35% of 30 = 10 (NOT 10.5)', () => {
    const s = createCapState(35, 30);
    expect(s.perCategoryCap).toBe(10);
  });

  test('cap of 0 when the percent × budget rounds down to zero', () => {
    // 5% of 10 = 0.5 → floor = 0
    const s = createCapState(5, 10);
    expect(s.perCategoryCap).toBe(0);
  });

  test('100% effectively disables the cap — entire budget available to one category', () => {
    const s = createCapState(100, 50);
    expect(s.perCategoryCap).toBe(50);
  });

  test('starts with empty consumed and skipped maps', () => {
    const s = createCapState(35, 100);
    expect(s.consumedByCategory).toEqual({});
    expect(s.skippedByCategory).toEqual({});
  });

  test('default constant matches the V1.2-PLAN expected value (35%)', () => {
    expect(DEFAULT_PER_CHECK_CAP_PERCENT).toBe(35);
  });
});

describe('canCallForCategory — admission predicate', () => {
  test('true when nothing has been consumed yet', () => {
    const s = createCapState(50, 10); // cap = 5
    expect(canCallForCategory(s, 'no-direct-dom')).toBe(true);
  });

  test('true while consumed < cap', () => {
    const s = createCapState(50, 10); // cap = 5
    recordCallForCategory(s, 'no-direct-dom');
    recordCallForCategory(s, 'no-direct-dom');
    expect(canCallForCategory(s, 'no-direct-dom')).toBe(true);
  });

  test('false the moment consumed reaches the cap', () => {
    const s = createCapState(50, 10); // cap = 5
    for (let i = 0; i < 5; i += 1) recordCallForCategory(s, 'no-direct-dom');
    expect(canCallForCategory(s, 'no-direct-dom')).toBe(false);
  });

  test('a cap of 0 blocks every category immediately', () => {
    const s = createCapState(5, 10); // cap = 0
    expect(canCallForCategory(s, 'no-direct-dom')).toBe(false);
    expect(canCallForCategory(s, 'missing-i18n')).toBe(false);
    expect(canCallForCategory(s, 'missing-test-coverage')).toBe(false);
  });

  test('one category exhausting its cap does NOT affect others', () => {
    const s = createCapState(50, 10); // cap = 5
    for (let i = 0; i < 5; i += 1) recordCallForCategory(s, 'missing-test-coverage');
    expect(canCallForCategory(s, 'missing-test-coverage')).toBe(false);
    expect(canCallForCategory(s, 'no-direct-dom')).toBe(true);
    expect(canCallForCategory(s, 'missing-i18n')).toBe(true);
  });

  test('cap of 100% lets one category consume the entire budget', () => {
    const s = createCapState(100, 5);
    for (let i = 0; i < 5; i += 1) recordCallForCategory(s, 'missing-test-coverage');
    expect(canCallForCategory(s, 'missing-test-coverage')).toBe(false);
    // Now this one category accounts for all 5 budget calls; per-category
    // cap = total = 5, so we never blocked another category along the way.
    expect(canCallForCategory(s, 'no-direct-dom')).toBe(true);
  });
});

describe('recordCallForCategory — consumed counter', () => {
  test('increments from absent to 1 on first call', () => {
    const s = createCapState(100, 10);
    recordCallForCategory(s, 'no-direct-dom');
    expect(s.consumedByCategory['no-direct-dom']).toBe(1);
  });

  test('increments monotonically per call', () => {
    const s = createCapState(100, 10);
    recordCallForCategory(s, 'no-direct-dom');
    recordCallForCategory(s, 'no-direct-dom');
    recordCallForCategory(s, 'no-direct-dom');
    expect(s.consumedByCategory['no-direct-dom']).toBe(3);
  });

  test('keeps each CheckId counted independently', () => {
    const s = createCapState(100, 10);
    recordCallForCategory(s, 'no-direct-dom');
    recordCallForCategory(s, 'missing-i18n');
    recordCallForCategory(s, 'missing-i18n');
    expect(s.consumedByCategory['no-direct-dom']).toBe(1);
    expect(s.consumedByCategory['missing-i18n']).toBe(2);
    expect(s.consumedByCategory['no-sync-odata']).toBeUndefined();
  });
});

describe('recordSkippedForCategory + getSkippedCounts — skipped accounting', () => {
  test('absent CheckIds do not appear in the snapshot', () => {
    const s = createCapState(100, 10);
    expect(getSkippedCounts(s)).toEqual({});
  });

  test('returns the per-CheckId count after each recorded skip', () => {
    const s = createCapState(50, 10); // cap = 5
    for (let i = 0; i < 5; i += 1) recordCallForCategory(s, 'missing-test-coverage');
    // Three further attempts are blocked → 3 skips.
    for (let i = 0; i < 3; i += 1) recordSkippedForCategory(s, 'missing-test-coverage');
    expect(getSkippedCounts(s)).toEqual({ 'missing-test-coverage': 3 });
  });

  test('snapshot is a defensive copy — mutating the result does not corrupt state', () => {
    const s = createCapState(100, 10);
    recordSkippedForCategory(s, 'no-direct-dom');
    const snapshot = getSkippedCounts(s) as { 'no-direct-dom'?: number };
    snapshot['no-direct-dom'] = 999;
    expect(s.skippedByCategory['no-direct-dom']).toBe(1);
  });

  test('multiple categories accumulate independently', () => {
    const s = createCapState(100, 10);
    recordSkippedForCategory(s, 'no-direct-dom');
    recordSkippedForCategory(s, 'missing-i18n');
    recordSkippedForCategory(s, 'missing-i18n');
    expect(getSkippedCounts(s)).toEqual({
      'no-direct-dom': 1,
      'missing-i18n': 2,
    });
  });
});

describe('end-to-end usage — admission + accounting sequence', () => {
  test('cap of 3: first three calls succeed, next two are skipped, snapshot captures both', () => {
    const s = createCapState(30, 10); // cap = 3
    let succeeded = 0;
    let skipped = 0;
    for (let i = 0; i < 5; i += 1) {
      if (canCallForCategory(s, 'no-direct-dom')) {
        recordCallForCategory(s, 'no-direct-dom');
        succeeded += 1;
      } else {
        recordSkippedForCategory(s, 'no-direct-dom');
        skipped += 1;
      }
    }
    expect(succeeded).toBe(3);
    expect(skipped).toBe(2);
    expect(s.consumedByCategory['no-direct-dom']).toBe(3);
    expect(getSkippedCounts(s)).toEqual({ 'no-direct-dom': 2 });
  });
});
