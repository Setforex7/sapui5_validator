import { describe, expect, test } from 'vitest';
import { collectBaselineFindings } from '../../src/commands/baseline.js';
import type { BaselineLintResult } from '../../src/verify/baseline-lint.js';

/** A `lintProbe` that resolves to a fixed batched-lint result. */
function lintProbe(result: BaselineLintResult): () => Promise<BaselineLintResult> {
  return async () => result;
}

/** A `lintProbe` for a clean baseline — no per-file failures, no tool failure. */
function cleanLint(): () => Promise<BaselineLintResult> {
  return lintProbe({ failures: [], unattributable: [] });
}

describe('collectBaselineFindings', () => {
  test('no failures: empty findings + empty unattributable', async () => {
    const result = await collectBaselineFindings({ lintProbe: cleanLint() });
    expect(result.findings).toEqual([]);
    expect(result.unattributable).toEqual([]);
  });

  test('ui5lint failures yield baseline-ui5lint findings with raw stderr', async () => {
    let probeCalls = 0;
    const result = await collectBaselineFindings({
      lintProbe: async () => {
        probeCalls += 1;
        return {
          failures: [
            {
              file: 'webapp/x.js',
              step: 'ui5lint',
              explanation: 'ui5lint: parse error at line 1',
            },
          ],
          unattributable: [],
        };
      },
    });
    expect(result.unattributable).toEqual([]);
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.checkId).toBe('baseline-ui5lint');
    expect(f.source).toBe('baseline');
    expect(f.proposedFix).toBeNull();
    expect(f.file).toBe('webapp/x.js');
    if (f.proposedFix === null) {
      expect(f.explanation).toBe('ui5lint: parse error at line 1');
    }
    // The batched lint pass runs once — not once per in-scope file.
    expect(probeCalls).toBe(1);
  });

  test('eslint failures yield baseline-eslint findings', async () => {
    const result = await collectBaselineFindings({
      lintProbe: lintProbe({
        failures: [
          { file: 'a.js', step: 'eslint', explanation: 'no-unused-vars: unused' },
        ],
        unattributable: [],
      }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.checkId).toBe('baseline-eslint');
  });

  test('a lint tool failure is reported as unattributable, not as findings', async () => {
    // V1.3.1-3: an eslint exit-2 config error / a batched-lint timeout routes
    // to `unattributable` — a real abort, never fabricated per-file findings.
    const result = await collectBaselineFindings({
      lintProbe: lintProbe({
        failures: [],
        unattributable: [{ step: 'eslint', stderr: 'eslint: config error (exit 2)' }],
      }),
    });
    expect(result.findings).toEqual([]);
    expect(result.unattributable).toEqual([
      { step: 'eslint', stderr: 'eslint: config error (exit 2)' },
    ]);
  });

  test('emits one finding per failing file when multiple files fail ui5lint', async () => {
    const result = await collectBaselineFindings({
      lintProbe: lintProbe({
        failures: [
          { file: 'a.js', step: 'ui5lint', explanation: 'lint failure in a.js' },
          { file: 'b.js', step: 'ui5lint', explanation: 'lint failure in b.js' },
        ],
        unattributable: [],
      }),
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.checkId)).toEqual([
      'baseline-ui5lint',
      'baseline-ui5lint',
    ]);
  });

  test('karmaProbe runs once after the lint pass; failure becomes unattributable', async () => {
    let karmaCalls = 0;
    const result = await collectBaselineFindings({
      lintProbe: cleanLint(),
      karmaProbe: async () => {
        karmaCalls += 1;
        return { ok: false, stderr: 'karma: missing reporter' };
      },
    });
    expect(karmaCalls).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.unattributable).toEqual([
      { step: 'karma', stderr: 'karma: missing reporter' },
    ]);
  });

  test('karmaProbe is skipped when the lint pass already produced an unattributable failure', async () => {
    let karmaCalls = 0;
    const result = await collectBaselineFindings({
      lintProbe: lintProbe({
        failures: [],
        unattributable: [{ step: 'ui5lint', stderr: 'ui5lint crashed before any file' }],
      }),
      karmaProbe: async () => {
        karmaCalls += 1;
        return { ok: true, stderr: '' };
      },
    });
    expect(karmaCalls).toBe(0);
    expect(result.unattributable).toHaveLength(1);
  });

  test('karmaProbe passing leaves findings & unattributable empty', async () => {
    const result = await collectBaselineFindings({
      lintProbe: cleanLint(),
      karmaProbe: async () => ({ ok: true, stderr: '' }),
    });
    expect(result.findings).toEqual([]);
    expect(result.unattributable).toEqual([]);
  });

  test('V1.3-6: a runner-unavailable karmaProbe carries runnerUnavailable: true onto the entry', async () => {
    const result = await collectBaselineFindings({
      lintProbe: cleanLint(),
      karmaProbe: async () => ({
        ok: false,
        stderr: 'Cannot load browser "Bogus": it is not registered!',
        runnerUnavailable: true,
      }),
    });
    expect(result.findings).toEqual([]);
    expect(result.unattributable).toEqual([
      {
        step: 'karma',
        stderr: 'Cannot load browser "Bogus": it is not registered!',
        runnerUnavailable: true,
      },
    ]);
  });

  test('V1.3-6: a test-failure karmaProbe carries runnerUnavailable: false onto the entry', async () => {
    const result = await collectBaselineFindings({
      lintProbe: cleanLint(),
      karmaProbe: async () => ({
        ok: false,
        stderr: 'karma: 1 test failed',
        runnerUnavailable: false,
      }),
    });
    expect(result.unattributable).toEqual([
      { step: 'karma', stderr: 'karma: 1 test failed', runnerUnavailable: false },
    ]);
  });

  // V1.3.1-2 work item C — regression coverage for the per-file Finding
  // attribution contract validate's baseline-fix loop depends on
  // (V1.3.1-PLAN Part II §2.2). This is the safety net for V1.3.1-3's
  // collectBaselineFindings rewrite to a batched baseline-lint path: each
  // failing file must still yield exactly one Finding with a single
  // resolvable project-relative path and only its own lint output.
  //
  // V1.3.1-3 plumbing update (§4.5): the collector is now driven by the
  // batched-lint seam (`lintProbe`) instead of `verifyFn`; the assertions
  // below are BYTE-FOR-BYTE unchanged — they are the contract this rewrite
  // must preserve.
  test('per-file baseline attribution: one resolvable Finding per failing file, no cross-file leakage', async () => {
    // A mixed file set: Alpha + Gamma fail ui5lint, Beta fails eslint. Each
    // batched-lint failure carries only that file's own lint output.
    const result = await collectBaselineFindings({
      lintProbe: lintProbe({
        failures: [
          {
            file: 'webapp/controller/Alpha.controller.js',
            step: 'ui5lint',
            explanation: 'ui5lint: parse error in webapp/controller/Alpha.controller.js',
          },
          {
            file: 'webapp/controller/Beta.controller.js',
            step: 'eslint',
            explanation: 'eslint: no-unused-vars in webapp/controller/Beta.controller.js',
          },
          {
            file: 'webapp/view/Gamma.view.xml',
            step: 'ui5lint',
            explanation: 'ui5lint: parse error in webapp/view/Gamma.view.xml',
          },
        ],
        unattributable: [],
      }),
    });

    expect(result.unattributable).toEqual([]);
    // One Finding per failing file — not one merged multi-file finding.
    expect(result.findings).toHaveLength(3);

    const cases: ReadonlyArray<{
      readonly rel: string;
      readonly checkId: 'baseline-ui5lint' | 'baseline-eslint';
      readonly ownMarker: string;
      readonly foreignMarkers: readonly string[];
    }> = [
      {
        rel: 'webapp/controller/Alpha.controller.js',
        checkId: 'baseline-ui5lint',
        ownMarker: 'Alpha.controller.js',
        foreignMarkers: ['Beta.controller.js', 'Gamma.view.xml'],
      },
      {
        rel: 'webapp/controller/Beta.controller.js',
        checkId: 'baseline-eslint',
        ownMarker: 'Beta.controller.js',
        foreignMarkers: ['Alpha.controller.js', 'Gamma.view.xml'],
      },
      {
        rel: 'webapp/view/Gamma.view.xml',
        checkId: 'baseline-ui5lint',
        ownMarker: 'Gamma.view.xml',
        foreignMarkers: ['Alpha.controller.js', 'Beta.controller.js'],
      },
    ];

    for (const c of cases) {
      const f = result.findings.find((x) => x.file === c.rel);
      expect(f, `expected a baseline Finding keyed by ${c.rel}`).toBeDefined();
      if (f === undefined) continue;
      expect(f.source).toBe('baseline');
      expect(f.checkId).toBe(c.checkId);
      expect(f.proposedFix).toBeNull();
      // A single resolvable project-relative path: no leading slash, no newline.
      expect(f.file.startsWith('/')).toBe(false);
      expect(f.file).not.toContain('\n');
      // `explanation` lives on the proposedFix === null arm of the Finding
      // union — narrow before reading it (matches this file's existing tests).
      if (f.proposedFix === null) {
        expect(f.explanation).toContain(c.ownMarker);
        for (const foreign of c.foreignMarkers) {
          expect(f.explanation).not.toContain(foreign);
        }
      }
    }
  });
});
