import { describe, expect, test } from 'vitest';
import { KARMA_BINARY, runKarma } from '../../src/verify/karma.js';
import type { ExecResult } from '../../src/util/exec.js';

interface FakeCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly preferLocal?: boolean;
  readonly timeout?: number;
}

function makeFakeExec(response: Partial<ExecResult> = {}): {
  exec: (
    file: string,
    args?: readonly string[],
    opts?: {
      cwd?: string;
      preferLocal?: boolean;
      signal?: AbortSignal;
      timeout?: number;
    },
  ) => Promise<ExecResult>;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const exec = async (
    file: string,
    args: readonly string[] = [],
    opts: {
      cwd?: string;
      preferLocal?: boolean;
      signal?: AbortSignal;
      timeout?: number;
    } = {},
  ): Promise<ExecResult> => {
    calls.push({
      file,
      args: [...args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.preferLocal !== undefined ? { preferLocal: opts.preferLocal } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    });
    return {
      ok: response.ok ?? true,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      exitCode: response.exitCode ?? 0,
      durationMs: response.durationMs ?? 50,
    };
  };
  return { exec, calls };
}

describe('runKarma', () => {
  test('runs `karma start` with preferLocal + project cwd by default', async () => {
    const { exec, calls } = makeFakeExec({ ok: true, stdout: 'TOTAL: 2 SUCCESS' });
    const result = await runKarma({
      projectRoot: '/proj',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      execImpl: exec,
    });
    expect(result.ok).toBe(true);
    expect(result.testFiles).toEqual(['webapp/test/unit/Foo.qunit.js']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(KARMA_BINARY);
    expect(calls[0]?.args).toEqual(['start']);
    expect(calls[0]?.cwd).toBe('/proj');
    expect(calls[0]?.preferLocal).toBe(true);
  });

  test('appends explicit config file when provided', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runKarma({
      projectRoot: '/proj',
      configFile: 'karma.conf.cjs',
      execImpl: exec,
    });
    expect(calls[0]?.args).toEqual(['start', 'karma.conf.cjs']);
  });

  test('test failure: ok=false, raw stdout preserved (karma reports to stdout)', async () => {
    const failureLog =
      'Chrome Headless 120.0.0 webapp/test/unit/Foo.qunit.js: FAILED\n  expected 1, got 2\nTOTAL: 1 FAILED';
    const { exec } = makeFakeExec({
      ok: false,
      exitCode: 1,
      stdout: failureLog,
      stderr: '',
    });
    const result = await runKarma({
      projectRoot: '/proj',
      testFiles: ['webapp/test/unit/Foo.qunit.js'],
      execImpl: exec,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(failureLog); // raw, not summarized
  });

  test('forwards timeoutMs to exec when set', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runKarma({ projectRoot: '/p', timeoutMs: 60_000, execImpl: exec });
    expect(calls[0]?.timeout).toBe(60_000);
  });

  test('omitting testFiles still runs karma and records an empty list', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    const result = await runKarma({ projectRoot: '/p', execImpl: exec });
    expect(calls[0]?.args).toEqual(['start']);
    expect(result.testFiles).toEqual([]);
  });
});
