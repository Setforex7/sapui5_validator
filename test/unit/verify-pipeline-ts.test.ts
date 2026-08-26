/**
 * V1.9 TS-V1-FW + TS-VERIFY — the TypeScript static verify lane in
 * `verifyArtifact`.
 *
 * The lane is ui5lint → tsc → (config-gated) eslint, with NO karma step by
 * construction (the never-build firewall). These witnesses pin: karma is never
 * invoked even with `testFiles` present + a karma adapter wired; a tsc failure
 * fails the verify; `tscEnabled: false` skips tsc (ui5lint still covers it); the
 * step order is `ui5lint, tsc, eslint` (never `karma`).
 */

import { describe, expect, test } from 'vitest';
import type { EslintRunArgs, EslintResult } from '../../src/verify/eslint.js';
import type { KarmaRunArgs, KarmaResult } from '../../src/verify/karma.js';
import type { TscRunArgs, TscResult } from '../../src/verify/tsc.js';
import type { Ui5LintRunArgs, Ui5LintResult } from '../../src/verify/ui5lint.js';
import { verifyArtifact, type VerifyAdapters } from '../../src/verify/pipeline.js';

interface CallLog {
  ui5lint: Ui5LintRunArgs[];
  eslint: EslintRunArgs[];
  karma: KarmaRunArgs[];
  tsc: TscRunArgs[];
}

function mkAdapters(behaviour: {
  ui5lint?: Partial<Ui5LintResult>;
  eslint?: Partial<EslintResult>;
  karma?: Partial<KarmaResult>;
  tsc?: Partial<TscResult>;
}): { adapters: VerifyAdapters; calls: CallLog } {
  const calls: CallLog = { ui5lint: [], eslint: [], karma: [], tsc: [] };
  const adapters: VerifyAdapters = {
    ui5lint: async (args) => {
      calls.ui5lint.push(args);
      return {
        ok: behaviour.ui5lint?.ok ?? true,
        stdout: behaviour.ui5lint?.stdout ?? '',
        stderr: behaviour.ui5lint?.stderr ?? '',
        exitCode: behaviour.ui5lint?.exitCode ?? 0,
        durationMs: 1,
      };
    },
    eslint: async (args) => {
      calls.eslint.push(args);
      return {
        ok: behaviour.eslint?.ok ?? true,
        stdout: behaviour.eslint?.stdout ?? '',
        stderr: behaviour.eslint?.stderr ?? '',
        exitCode: behaviour.eslint?.exitCode ?? 0,
        durationMs: 1,
      };
    },
    karma: async (args) => {
      calls.karma.push(args);
      return {
        ok: behaviour.karma?.ok ?? true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        testFiles: [],
      };
    },
    tsc: async (args) => {
      calls.tsc.push(args);
      return {
        ok: behaviour.tsc?.ok ?? true,
        stdout: behaviour.tsc?.stdout ?? '',
        stderr: behaviour.tsc?.stderr ?? '',
        exitCode: behaviour.tsc?.exitCode ?? 0,
        durationMs: 1,
      };
    },
  };
  return { adapters, calls };
}

describe('verifyArtifact — TS static lane (TS-V1-FW + TS-VERIFY)', () => {
  test('THE FIREWALL: a TS verify with testFiles present + a karma adapter NEVER calls karma', async () => {
    const { adapters, calls } = mkAdapters({});
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/App.controller.ts',
      // testFiles present AND a karma adapter wired — the JS lane would run it.
      testFiles: ['webapp/test/unit/controller/App.controller.qunit.ts'],
      eslintEnabled: true,
      tscEnabled: true,
      language: 'ts',
      adapters,
    });
    expect(result.ok).toBe(true);
    // The load-bearing assertion: karma is structurally unreachable on the TS lane.
    expect(calls.karma).toHaveLength(0);
    // The lane is ui5lint → tsc → eslint, in that order, no karma token at all.
    expect(result.steps.map((s) => s.step)).toEqual(['ui5lint', 'tsc', 'eslint']);
    expect(result.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(calls.ui5lint).toHaveLength(1);
    expect(calls.tsc).toHaveLength(1);
    expect(calls.eslint).toHaveLength(1);
  });

  test('a type-breaking fix fails verify (failedStep tsc); karma never called', async () => {
    const { adapters, calls } = mkAdapters({
      tsc: { ok: false, exitCode: 2, stdout: "App.controller.ts(7,3): error TS2322." },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/App.controller.ts',
      testFiles: ['webapp/test/unit/App.controller.qunit.ts'],
      eslintEnabled: true,
      tscEnabled: true,
      language: 'ts',
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('tsc');
    expect(result.feedbackForLlm).toContain('TS2322');
    // tsc failed → eslint is not reached, and karma is never on this lane.
    expect(calls.eslint).toHaveLength(0);
    expect(calls.karma).toHaveLength(0);
  });

  test('tscEnabled:false skips the tsc step (ui5lint covers it), still passes; no karma', async () => {
    const { adapters, calls } = mkAdapters({});
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/App.controller.ts',
      eslintEnabled: false,
      tscEnabled: false,
      language: 'ts',
      adapters,
    });
    expect(result.ok).toBe(true);
    expect(calls.tsc).toHaveLength(0);
    const tscStep = result.steps.find((s) => s.step === 'tsc');
    expect(tscStep?.status).toBe('skipped');
    expect(result.steps.map((s) => s.step)).toEqual(['ui5lint', 'tsc', 'eslint']);
    expect(result.steps.find((s) => s.step === 'eslint')?.status).toBe('skipped');
    expect(calls.karma).toHaveLength(0);
  });

  test('eslint runs on the TS lane when enabled, and an eslint failure fails verify', async () => {
    const { adapters, calls } = mkAdapters({
      eslint: { ok: false, exitCode: 1, stdout: 'App.controller.ts: error @typescript-eslint/no-explicit-any' },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/App.controller.ts',
      eslintEnabled: true,
      tscEnabled: false,
      language: 'ts',
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('eslint');
    expect(calls.eslint).toHaveLength(1);
    expect(calls.karma).toHaveLength(0);
  });

  test('ui5lint failure short-circuits the TS lane (no tsc/eslint/karma)', async () => {
    const { adapters, calls } = mkAdapters({
      ui5lint: { ok: false, exitCode: 1, stderr: 'ui5: some-rule' },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/App.controller.ts',
      eslintEnabled: true,
      tscEnabled: true,
      language: 'ts',
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('ui5lint');
    expect(calls.tsc).toHaveLength(0);
    expect(calls.eslint).toHaveLength(0);
    expect(calls.karma).toHaveLength(0);
  });
});
