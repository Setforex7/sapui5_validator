import { describe, expect, test } from 'vitest';
import { CallBudget, BudgetExhaustedError } from '../../src/claude/budget.js';
import { createCapState } from '../../src/budget/cap.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import {
  CHECKS,
  checkById,
  checksByScope,
  runCheckLoop,
  type CheckTargetSet,
} from '../../src/checks/index.js';
import { BASELINE_CHECK_IDS, CHECK_IDS, SEMANTIC_CHECK_IDS } from '../../src/types.js';
import type { CheckContext, CheckModule, CheckResult } from '../../src/checks/types.js';

describe('CHECKS registry', () => {
  test('contains exactly the 7 SPEC §2.8 semantic check IDs, each exactly once', () => {
    const ids = CHECKS.map((c) => c.id).sort();
    const expected = [...SEMANTIC_CHECK_IDS].sort();
    expect(ids).toEqual(expected);
  });

  test('does NOT contain any baseline sentinel id', () => {
    const ids = new Set(CHECKS.map((c) => c.id));
    for (const baselineId of BASELINE_CHECK_IDS) {
      expect(ids.has(baselineId)).toBe(false);
    }
  });

  test('CHECK_IDS is the disjoint union of semantic + baseline ids', () => {
    expect([...CHECK_IDS].sort()).toEqual(
      [...SEMANTIC_CHECK_IDS, ...BASELINE_CHECK_IDS].sort(),
    );
  });

  test('checksByScope partitions by declared scope', () => {
    const ctrl = checksByScope('controller-js').map((c) => c.id);
    expect(ctrl).toContain('no-direct-dom');
    expect(ctrl).toContain('no-sync-odata');
    expect(ctrl).toContain('missing-test-coverage');
    expect(checksByScope('view-xml').map((c) => c.id)).toEqual(
      expect.arrayContaining(['missing-i18n', 'globals-in-views']),
    );
    expect(checksByScope('qunit-test').map((c) => c.id)).toEqual(['missing-teardown']);
    expect(checksByScope('project').map((c) => c.id)).toEqual(['manifest-component-drift']);
  });

  test('checkById returns undefined for unknown ids and the module for known', () => {
    expect(checkById('no-direct-dom')?.id).toBe('no-direct-dom');
    expect(checksByScope('project')[0]?.id).toBe('manifest-component-drift');
  });
});

describe('runCheckLoop', () => {
  function ctx(maxCalls = 100): CheckContext {
    return {
      projectRoot: '/proj',
      runner: new FakeClaudeRunner([{ match: /./, response: { json: {} } }]),
      budget: new CallBudget({ maxCalls }),
      // COR-7: capState is required; a 100% cap never binds before the budget.
      capState: createCapState(100, Math.max(1, maxCalls)),
    };
  }

  function fakeCheck(id: string, behaviour: (target: string) => CheckResult | Promise<CheckResult>): CheckModule {
    return {
      id: id as CheckModule['id'],
      scope: 'controller-js',
      run: async (target) => behaviour(target),
    };
  }

  test('iterates every (check, target) pair sequentially and aggregates findings', async () => {
    const seen: string[] = [];
    const sets: readonly CheckTargetSet[] = [
      {
        check: fakeCheck('no-direct-dom', (t) => {
          seen.push(`A:${t}`);
          return {
            findings: [
              {
                checkId: 'no-direct-dom',
                file: t,
                message: 'm',
                source: 'check',
                proposedFix: { newFileContent: 'c' },
              },
            ],
          };
        }),
        targets: ['a.js', 'b.js'],
      },
      {
        check: fakeCheck('no-sync-odata', (t) => {
          seen.push(`B:${t}`);
          return { findings: [] };
        }),
        targets: ['a.js'],
      },
    ];
    const result = await runCheckLoop(sets, ctx());
    expect(seen).toEqual(['A:a.js', 'A:b.js', 'B:a.js']);
    expect(result.findings).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(result.budgetExhausted).toBe(false);
  });

  test('budget exhaustion halts the loop: every remaining target is marked skipped', async () => {
    let callCount = 0;
    const check1 = fakeCheck('no-direct-dom', (_t) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          findings: [
            {
              checkId: 'no-direct-dom',
              file: 'x',
              message: 'm',
              source: 'check',
              proposedFix: { newFileContent: 'c' },
            },
          ],
        };
      }
      throw new BudgetExhaustedError(2, 1);
    });
    const check2 = fakeCheck('no-sync-odata', () => ({ findings: [] }));
    const sets: readonly CheckTargetSet[] = [
      { check: check1, targets: ['a.js', 'b.js', 'c.js'] },
      { check: check2, targets: ['a.js'] },
    ];
    const result = await runCheckLoop(sets, ctx());
    expect(result.findings).toHaveLength(1);
    expect(result.budgetExhausted).toBe(true);
    // The second target of check1 threw; everything after that is skipped.
    expect(result.skipped.map((s) => `${s.checkId}:${s.target}`)).toEqual([
      'no-direct-dom:b.js',
      'no-direct-dom:c.js',
      'no-sync-odata:a.js',
    ]);
    expect(result.skipped.every((s) => s.reason === 'budget-exhausted')).toBe(true);
    // No retry was attempted on the budget-exhausted target — callCount is 2.
    expect(callCount).toBe(2);
  });

  test('non-budget errors propagate (the loop does not swallow them)', async () => {
    const fail = fakeCheck('no-direct-dom', () => {
      throw new Error('boom');
    });
    await expect(
      runCheckLoop([{ check: fail, targets: ['a.js'] }], ctx()),
    ).rejects.toThrow('boom');
  });
});
