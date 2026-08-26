import { describe, expect, test } from 'vitest';
import type { EslintRunArgs, EslintResult } from '../../src/verify/eslint.js';
import type { KarmaRunArgs, KarmaResult } from '../../src/verify/karma.js';
import {
  karmaModuleLoadFailure,
  karmaRunnerUnavailable,
  verifyArtifact,
  type VerifyAdapters,
} from '../../src/verify/pipeline.js';
import type { Ui5LintRunArgs, Ui5LintResult } from '../../src/verify/ui5lint.js';

interface CallLog {
  ui5lint: Ui5LintRunArgs[];
  eslint: EslintRunArgs[];
  karma: KarmaRunArgs[];
}

function mkAdapters(behaviour: {
  ui5lint?: Partial<Ui5LintResult>;
  eslint?: Partial<EslintResult>;
  karma?: Partial<KarmaResult>;
}): { adapters: VerifyAdapters; calls: CallLog } {
  const calls: CallLog = { ui5lint: [], eslint: [], karma: [] };
  const adapters: VerifyAdapters = {
    ui5lint: async (args) => {
      calls.ui5lint.push(args);
      return {
        ok: behaviour.ui5lint?.ok ?? true,
        stdout: behaviour.ui5lint?.stdout ?? '',
        stderr: behaviour.ui5lint?.stderr ?? '',
        exitCode: behaviour.ui5lint?.exitCode ?? 0,
        durationMs: behaviour.ui5lint?.durationMs ?? 1,
      };
    },
    eslint: async (args) => {
      calls.eslint.push(args);
      return {
        ok: behaviour.eslint?.ok ?? true,
        stdout: behaviour.eslint?.stdout ?? '',
        stderr: behaviour.eslint?.stderr ?? '',
        exitCode: behaviour.eslint?.exitCode ?? 0,
        durationMs: behaviour.eslint?.durationMs ?? 1,
      };
    },
    karma: async (args) => {
      calls.karma.push(args);
      return {
        ok: behaviour.karma?.ok ?? true,
        stdout: behaviour.karma?.stdout ?? '',
        stderr: behaviour.karma?.stderr ?? '',
        exitCode: behaviour.karma?.exitCode ?? 0,
        durationMs: behaviour.karma?.durationMs ?? 1,
        testFiles: behaviour.karma?.testFiles ?? [],
      };
    },
  };
  return { adapters, calls };
}

describe('verifyArtifact — happy path', () => {
  test('all three steps pass when eslint enabled and test files present', async () => {
    const { adapters, calls } = mkAdapters({});
    const result = await verifyArtifact({
      projectRoot: '/proj',
      file: 'webapp/Component.js',
      testFiles: ['webapp/test/unit/Component.qunit.js'],
      eslintEnabled: true,
      adapters,
    });
    expect(result.ok).toBe(true);
    expect(result.feedbackForLlm).toBe('');
    expect(result.failedStep).toBeUndefined();
    expect(result.steps.map((s) => s.step)).toEqual(['ui5lint', 'eslint', 'karma']);
    expect(result.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(calls.ui5lint[0]?.file).toBe('webapp/Component.js');
    expect(calls.eslint[0]?.file).toBe('webapp/Component.js');
    expect(calls.karma[0]?.testFiles).toEqual(['webapp/test/unit/Component.qunit.js']);
  });

  test('eslintEnabled=false records a "skipped" step, then runs karma', async () => {
    const { adapters, calls } = mkAdapters({});
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/Foo.js',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      eslintEnabled: false,
      adapters,
    });
    expect(result.ok).toBe(true);
    expect(calls.eslint).toHaveLength(0);
    const eslintStep = result.steps.find((s) => s.step === 'eslint');
    expect(eslintStep?.status).toBe('skipped');
    expect(eslintStep?.skipReason).toMatch(/eslint/);
    expect(calls.karma).toHaveLength(1);
  });

  test('empty testFiles skips karma with reason', async () => {
    const { adapters, calls } = mkAdapters({});
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/Foo.js',
      eslintEnabled: true,
      adapters,
    });
    expect(result.ok).toBe(true);
    expect(calls.karma).toHaveLength(0);
    const karmaStep = result.steps.find((s) => s.step === 'karma');
    expect(karmaStep?.status).toBe('skipped');
    expect(karmaStep?.skipReason).toMatch(/test files/);
  });
});

describe('verifyArtifact — failure short-circuits and feeds raw output back', () => {
  test('ui5lint failure: no eslint or karma call; feedback = stderr', async () => {
    const { adapters, calls } = mkAdapters({
      ui5lint: { ok: false, exitCode: 1, stderr: 'ui5: no-globals at line 5', stdout: '' },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/Foo.js',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      eslintEnabled: true,
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('ui5lint');
    expect(result.feedbackForLlm).toBe('ui5: no-globals at line 5');
    expect(calls.eslint).toHaveLength(0);
    expect(calls.karma).toHaveLength(0);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('failed');
  });

  test('eslint failure: karma is not called; raw stdout preserved (eslint reports to stdout)', async () => {
    const eslintStdout =
      '/proj/Foo.js\n  5:1  error  Unexpected console statement  no-console\n\n1 problem';
    const { adapters, calls } = mkAdapters({
      eslint: { ok: false, exitCode: 1, stdout: eslintStdout, stderr: '' },
    });
    const result = await verifyArtifact({
      projectRoot: '/proj',
      file: 'Foo.js',
      testFiles: ['t.qunit.js'],
      eslintEnabled: true,
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('eslint');
    expect(result.feedbackForLlm).toBe(eslintStdout);
    expect(calls.karma).toHaveLength(0);
    expect(result.steps[0]?.status).toBe('passed');
    expect(result.steps[1]?.status).toBe('failed');
  });

  test('karma failure: feedback combines stderr and stdout when both present', async () => {
    const stderr = 'karma server crashed on launch';
    const stdout = 'TOTAL: 1 FAILED';
    const { adapters } = mkAdapters({
      karma: { ok: false, exitCode: 1, stderr, stdout },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/Foo.js',
      testFiles: ['t.qunit.js'],
      eslintEnabled: true,
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('karma');
    expect(result.feedbackForLlm).toBe(`${stderr}\n${stdout}`);
  });

  test('failed step with empty stderr falls back to stdout for feedback', async () => {
    const { adapters } = mkAdapters({
      ui5lint: { ok: false, exitCode: 2, stdout: 'just stdout text', stderr: '' },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'a.js',
      eslintEnabled: false,
      adapters,
    });
    expect(result.ok).toBe(false);
    expect(result.feedbackForLlm).toBe('just stdout text');
  });
});

describe('verifyArtifact — signal & defaults', () => {
  test('propagates AbortSignal to every invoked adapter', async () => {
    const ac = new AbortController();
    const { adapters, calls } = mkAdapters({});
    await verifyArtifact({
      projectRoot: '/p',
      file: 'a.js',
      testFiles: ['t.qunit.js'],
      eslintEnabled: true,
      adapters,
      signal: ac.signal,
    });
    expect(calls.ui5lint[0]?.signal).toBe(ac.signal);
    expect(calls.eslint[0]?.signal).toBe(ac.signal);
    expect(calls.karma[0]?.signal).toBe(ac.signal);
  });

  test('karmaConfig override is forwarded to the karma adapter', async () => {
    const { adapters, calls } = mkAdapters({});
    await verifyArtifact({
      projectRoot: '/p',
      file: 'a.js',
      testFiles: ['t.qunit.js'],
      eslintEnabled: false,
      karmaConfig: 'karma.conf.cjs',
      adapters,
    });
    expect(calls.karma[0]?.configFile).toBe('karma.conf.cjs');
  });

  // V1.3.1-3 Problem 3 — the karma step's call site must bound the
  // subprocess. Witness B covers the ui5lint/eslint adapters directly; this
  // covers the karma wiring `verifyArtifact` adds.
  test('passes a numeric karma timeout to the karma adapter', async () => {
    const { adapters, calls } = mkAdapters({});
    await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/Foo.js',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      eslintEnabled: false,
      adapters,
    });
    expect(calls.karma).toHaveLength(1);
    expect(typeof calls.karma[0]?.timeoutMs).toBe('number');
  });

  // =====================================================================
  // V1.3.3-3 witnesses — Bug B (karma module-load-failure classification +
  // pipeline status surface). Today's pipeline status ladder maps every
  // failed-karma case to either `'runner-unavailable'` (bootstrap marker
  // matched) or `'failed'` (everything else). V1.3.3-5 adds the
  // `'module-load-failure'` branch + the `karmaModuleLoadFailure` helper;
  // these witnesses fail with specific assertion mismatches against the
  // V1.3.3-3 identity stubs (helper returns false; classifier still routes
  // module-load shapes to `'test-failure'` → `'failed'`).
  // =====================================================================

  test('V1.3.3-3 (Bug B): karma classified module-load-failure → status module-load-failure on the verify step; karmaModuleLoadFailure === true', async () => {
    const moduleLoadStdout =
      'failed to load JavaScript resource: sap/ui/export/Spreadsheet.js -  ' +
      'sap.ui.ModuleSystem\n' +
      'WARN [Chrome Headless 131.0.0.0]: Disconnected, because no message in 30000 ms.\n';
    const { adapters } = mkAdapters({
      karma: { ok: false, exitCode: 1, stdout: moduleLoadStdout, stderr: '' },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/Foo.controller.js',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      eslintEnabled: false,
      adapters,
    });
    expect(result.ok).toBe(false);
    const karmaStep = result.steps.find((s) => s.step === 'karma');
    expect(karmaStep?.status).toBe('module-load-failure');
    expect(karmaModuleLoadFailure(result)).toBe(true);
    // Sibling check: a module-load failure is not a runner-unavailable one.
    expect(karmaRunnerUnavailable(result)).toBe(false);
  });

  test('V1.3.3-3 (Bug B): karma classified runner-unavailable → status runner-unavailable (unchanged); karmaModuleLoadFailure === false', async () => {
    const bootstrapStdout =
      'ERROR [launcher]: Cannot load browser "Bogus": it is not registered!\n';
    const { adapters } = mkAdapters({
      karma: { ok: false, exitCode: 1, stdout: bootstrapStdout, stderr: '' },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/Foo.controller.js',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      eslintEnabled: false,
      adapters,
    });
    const karmaStep = result.steps.find((s) => s.step === 'karma');
    expect(karmaStep?.status).toBe('runner-unavailable');
    expect(karmaRunnerUnavailable(result)).toBe(true);
    expect(karmaModuleLoadFailure(result)).toBe(false);
  });

  test('V1.3.3-3 (Bug B): karma classified test-failure → status failed (unchanged); both new helpers return false', async () => {
    const { adapters } = mkAdapters({
      karma: {
        ok: false,
        exitCode: 1,
        stdout: 'TOTAL: 1 FAILED\n',
        stderr: 'karma: assertion mismatch',
      },
    });
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'webapp/controller/Foo.controller.js',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      eslintEnabled: false,
      adapters,
    });
    const karmaStep = result.steps.find((s) => s.step === 'karma');
    expect(karmaStep?.status).toBe('failed');
    expect(karmaModuleLoadFailure(result)).toBe(false);
    expect(karmaRunnerUnavailable(result)).toBe(false);
  });

  test('default adapters are wired when input.adapters is omitted', async () => {
    // Sanity: omitting `adapters` should still run, defaulting to the real
    // adapters. We can't easily intercept those without a deeper mock, so
    // we instead supply just one adapter and let the others default — that
    // still exercises the "?? default" branch for the supplied one without
    // shelling out (eslint and karma are guarded by `eslintEnabled=false`
    // and empty testFiles, respectively).
    let ui5lintCalls = 0;
    const result = await verifyArtifact({
      projectRoot: '/p',
      file: 'a.js',
      eslintEnabled: false,
      adapters: {
        ui5lint: async () => {
          ui5lintCalls += 1;
          return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
        },
      },
    });
    expect(ui5lintCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.step === 'eslint')?.status).toBe('skipped');
    expect(result.steps.find((s) => s.step === 'karma')?.status).toBe('skipped');
  });
});

// =====================================================================
// R2.1(c) witnesses (AUDIT-v0.7.0 §5.3c + live §3.1) — transient-network
// evidence (ENOTFOUND / failed proxy) triggers exactly ONE karma re-run
// (a karma re-run only — the pipeline holds no LLM handle, so the retry
// cannot consume budget); a second consecutive transient failure
// classifies `runner-unavailable` (run-level, honest) so the retry loop
// aborts instead of quarantining a sound candidate. These witnesses fail
// on revert of the pipeline retry.
// =====================================================================

// Synthesized from the lines quoted in AUDIT-v0.7.0 §3.1: the cap_try
// formatter verify transcript (verify/e5a94d14…-karma.txt) that a
// transient DNS blip turned into a permanent module-load quarantine.
const ENOTFOUND_KARMA_STDOUT =
  '10 06 2026 01:58:12.345:WARN [proxy]: Failed to proxy /resources/sap-ui-core.js ' +
  '(ENOTFOUND: getaddrinfo ENOTFOUND sdk.openui5.org)\n' +
  'WARN [Chrome Headless 131.0.0.0 (Windows 10)]: Disconnected, ' +
  'because no message in 30000 ms.\n';

function seqKarmaAdapters(seq: readonly Partial<KarmaResult>[]): {
  adapters: VerifyAdapters;
  karmaCalls: KarmaRunArgs[];
} {
  const karmaCalls: KarmaRunArgs[] = [];
  const adapters: VerifyAdapters = {
    ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    karma: async (args) => {
      const step = seq[Math.min(karmaCalls.length, seq.length - 1)]!;
      karmaCalls.push(args);
      return {
        ok: step.ok ?? true,
        stdout: step.stdout ?? '',
        stderr: step.stderr ?? '',
        exitCode: step.exitCode ?? 0,
        durationMs: 1,
        testFiles: [],
      };
    },
  };
  return { adapters, karmaCalls };
}

describe('(R2.1c) verifyArtifact — transient-network karma retry', () => {
  const input = (adapters: VerifyAdapters) => ({
    projectRoot: '/p',
    file: 'webapp/model/formatter.js',
    testFiles: ['webapp/test/unit/model/formatter.qunit.js'],
    eslintEnabled: false,
    adapters,
  });

  test('ENOTFOUND on first verify, success on retry → verify passes; exactly one karma re-run', async () => {
    const { adapters, karmaCalls } = seqKarmaAdapters([
      { ok: false, exitCode: 1, stdout: ENOTFOUND_KARMA_STDOUT },
      { ok: true, exitCode: 0 },
    ]);
    const result = await verifyArtifact(input(adapters));
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.step === 'karma')?.status).toBe('passed');
    expect(karmaCalls).toHaveLength(2);
  });

  test('ENOTFOUND on both runs → runner-unavailable (run-level), exactly two karma runs, NOT module-load', async () => {
    // The transcript also carries the no-message disconnect; pre-R2.1 the
    // classifier mapped that to module-load-failure and the retry loop
    // quarantined the candidate on first occurrence (the live §3.1 loss).
    const { adapters, karmaCalls } = seqKarmaAdapters([
      { ok: false, exitCode: 1, stdout: ENOTFOUND_KARMA_STDOUT },
      { ok: false, exitCode: 1, stdout: ENOTFOUND_KARMA_STDOUT },
    ]);
    const result = await verifyArtifact(input(adapters));
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.step === 'karma')?.status).toBe(
      'runner-unavailable',
    );
    expect(karmaRunnerUnavailable(result)).toBe(true);
    expect(karmaModuleLoadFailure(result)).toBe(false);
    // Bounded to EXACTLY one re-run — a persistent outage must not loop.
    expect(karmaCalls).toHaveLength(2);
  });

  test('ENOTFOUND first, genuine test failure on retry → classified normally (failed), not runner-unavailable', async () => {
    // No over-correction: once the CDN answers and the test genuinely
    // fails, the candidate keeps its refinement chance.
    const { adapters, karmaCalls } = seqKarmaAdapters([
      { ok: false, exitCode: 1, stdout: ENOTFOUND_KARMA_STDOUT },
      { ok: false, exitCode: 1, stdout: 'TOTAL: 1 FAILED, 2 SUCCESS\n' },
    ]);
    const result = await verifyArtifact(input(adapters));
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.step === 'karma')?.status).toBe('failed');
    expect(karmaRunnerUnavailable(result)).toBe(false);
    expect(karmaCalls).toHaveLength(2);
    // The feedback handed to the LLM is the FINAL attempt's (real) output.
    expect(result.feedbackForLlm).toContain('TOTAL: 1 FAILED');
  });

  test('non-transient failure → NO retry (karma runs once); guard against retry-burning ordinary failures', async () => {
    const { adapters, karmaCalls } = seqKarmaAdapters([
      { ok: false, exitCode: 1, stdout: 'TOTAL: 1 FAILED, 2 SUCCESS\n' },
    ]);
    const result = await verifyArtifact(input(adapters));
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.step === 'karma')?.status).toBe('failed');
    expect(karmaCalls).toHaveLength(1);
  });
});
