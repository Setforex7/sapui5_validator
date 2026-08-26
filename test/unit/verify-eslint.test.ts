import { describe, expect, test } from 'vitest';
import { ESLINT_BINARY, runEslint } from '../../src/verify/eslint.js';
import type { ExecOptions, ExecResult } from '../../src/util/exec.js';

interface FakeCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly preferLocal?: boolean;
}

function makeFakeExec(response: Partial<ExecResult> = {}): {
  exec: (
    file: string,
    args?: readonly string[],
    opts?: { cwd?: string; preferLocal?: boolean; signal?: AbortSignal },
  ) => Promise<ExecResult>;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const exec = async (
    file: string,
    args: readonly string[] = [],
    opts: { cwd?: string; preferLocal?: boolean; signal?: AbortSignal } = {},
  ): Promise<ExecResult> => {
    calls.push({
      file,
      args: [...args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.preferLocal !== undefined ? { preferLocal: opts.preferLocal } : {}),
    });
    return {
      ok: response.ok ?? true,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      exitCode: response.exitCode ?? 0,
      durationMs: response.durationMs ?? 3,
    };
  };
  return { exec, calls };
}

describe('runEslint', () => {
  test('targets the given file with preferLocal + cwd', async () => {
    const { exec, calls } = makeFakeExec({ ok: true, stdout: '' });
    const result = await runEslint({
      projectRoot: '/proj',
      file: 'webapp/controller/App.controller.js',
      execImpl: exec,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.file).toBe(ESLINT_BINARY);
    // SEC-4 — `--` end-of-options precedes the project-derived file.
    expect(calls[0]?.args).toEqual(['--', 'webapp/controller/App.controller.js']);
    expect(calls[0]?.cwd).toBe('/proj');
    expect(calls[0]?.preferLocal).toBe(true);
  });

  test('defaults to the project root (".") when no file given', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runEslint({ projectRoot: '/p', execImpl: exec });
    // No terminator for the constant `.` (not a project-derived positional).
    expect(calls[0]?.args).toEqual(['.']);
  });

  // SEC-4 (V1.8) — a path that begins with `-` must be passed as a filename,
  // never parsed as a flag. The `--` terminator guarantees it. Fails on revert:
  // drop the terminator and the args become just [file].
  test('a `-`-leading file path is guarded by `--` so it is treated as a filename', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runEslint({ projectRoot: '/p', file: '-rf.controller.js', execImpl: exec });
    expect(calls[0]?.args).toEqual(['--', '-rf.controller.js']);
    expect(calls[0]?.args[0]).toBe('--');
  });

  test('lint failure: ok=false, stdout preserved verbatim for LLM feedback', async () => {
    const raw =
      '/proj/webapp/controller/App.controller.js\n  5:13  error  Unexpected console statement  no-console\n\n1 problem (1 error, 0 warnings)';
    const { exec } = makeFakeExec({
      ok: false,
      exitCode: 1,
      stdout: raw,
      stderr: '',
    });
    const result = await runEslint({
      projectRoot: '/proj',
      file: 'webapp/controller/App.controller.js',
      execImpl: exec,
    });
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe(raw); // raw, not trimmed
    expect(result.exitCode).toBe(1);
  });

  test('passes through aborted signal when provided', async () => {
    const ac = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const exec = async (
      _f: string,
      _a: readonly string[] = [],
      opts: { signal?: AbortSignal } = {},
    ): Promise<ExecResult> => {
      receivedSignal = opts.signal;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    };
    await runEslint({
      projectRoot: '/p',
      file: 'a.js',
      execImpl: exec,
      signal: ac.signal,
    });
    expect(receivedSignal).toBe(ac.signal);
  });

  // V1.3.1-2 Problem 3 witness: a hung eslint must not freeze the run.
  // runEslint builds its ExecOptions with no `timeout` on master, so the
  // subprocess is unbounded. V1.3.1-3 adds ESLINT_TIMEOUT_MS.
  // V1.3.1-WITNESS: un-skip in V1.3.1-3.
  test('passes a numeric timeout to exec', async () => {
    let capturedOpts: ExecOptions | undefined;
    const exec = async (
      _file: string,
      _args: readonly string[] = [],
      opts: ExecOptions = {},
    ): Promise<ExecResult> => {
      capturedOpts = opts;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    };
    await runEslint({
      projectRoot: '/proj',
      file: 'webapp/controller/App.controller.js',
      execImpl: exec,
    });
    // Fails on master with `expected 'undefined' to be 'number'`.
    expect(typeof capturedOpts?.timeout).toBe('number');
  });
});
