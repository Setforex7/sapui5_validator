import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  runUi5Lint,
  UI5LINT_BINARY,
  Ui5LintFileOutsideProjectError,
} from '../../src/verify/ui5lint.js';
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
      durationMs: response.durationMs ?? 5,
    };
  };
  return { exec, calls };
}

describe('runUi5Lint', () => {
  test('passes file argument and preferLocal/cwd to exec', async () => {
    const { exec, calls } = makeFakeExec({ ok: true, stdout: 'clean' });
    const result = await runUi5Lint({
      projectRoot: '/project',
      file: 'webapp/Component.js',
      execImpl: exec,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('clean');
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(UI5LINT_BINARY);
    expect(calls[0]?.args).toEqual(['webapp/Component.js']);
    expect(calls[0]?.cwd).toBe('/project');
    expect(calls[0]?.preferLocal).toBe(true);
  });

  test('omits file arg when none provided (project-wide invocation)', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runUi5Lint({ projectRoot: '/p', execImpl: exec });
    expect(calls[0]?.args).toEqual([]);
  });

  test('failure is data, not exception: ok=false + raw stderr surfaced', async () => {
    const { exec } = makeFakeExec({
      ok: false,
      exitCode: 1,
      stdout: 'webapp/Component.js: 2 problems',
      stderr: 'no-global error',
    });
    const result = await runUi5Lint({ projectRoot: '/p', file: 'x.js', execImpl: exec });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('no-global error');
    expect(result.stdout).toContain('2 problems');
  });

  test('honours custom binary name', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runUi5Lint({
      projectRoot: '/p',
      file: 'a.js',
      binary: '/abs/path/ui5lint',
      execImpl: exec,
    });
    expect(calls[0]?.file).toBe('/abs/path/ui5lint');
  });

  // Bug 1 (V1.1-DIAGNOSIS.md §"Bug 1"): runtime callers (baseline collector,
  // fix loop) always pass an absolute path, but @ui5/linter rejects absolute
  // patterns. The adapter must normalize to a POSIX project-relative form.
  test('absolute path inside projectRoot is converted to a POSIX relative path', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    const projectRoot = path.resolve('/project');
    const fileAbs = path.join(projectRoot, 'webapp', 'controller', 'Main.controller.js');
    await runUi5Lint({ projectRoot, file: fileAbs, execImpl: exec });
    expect(calls[0]?.args).toEqual(['webapp/controller/Main.controller.js']);
  });

  test.skipIf(process.platform !== 'win32')(
    'Windows backslash absolute path is normalized to a POSIX relative path',
    async () => {
      const { exec, calls } = makeFakeExec({ ok: true });
      await runUi5Lint({
        projectRoot: 'C:\\project',
        file: 'C:\\project\\webapp\\controller\\Main.controller.js',
        execImpl: exec,
      });
      expect(calls[0]?.args).toEqual(['webapp/controller/Main.controller.js']);
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'Windows forward-slash absolute path is normalized to a POSIX relative path',
    async () => {
      const { exec, calls } = makeFakeExec({ ok: true });
      await runUi5Lint({
        projectRoot: 'C:/project',
        file: 'C:/project/webapp/controller/Main.controller.js',
        execImpl: exec,
      });
      expect(calls[0]?.args).toEqual(['webapp/controller/Main.controller.js']);
    },
  );

  test('already-relative file is passed through (slash-normalized)', async () => {
    const { exec, calls } = makeFakeExec({ ok: true });
    await runUi5Lint({
      projectRoot: path.resolve('/project'),
      file: 'webapp/Component.js',
      execImpl: exec,
    });
    expect(calls[0]?.args).toEqual(['webapp/Component.js']);
  });

  test('throws Ui5LintFileOutsideProjectError when absolute file is outside projectRoot', async () => {
    const { exec } = makeFakeExec({ ok: true });
    const projectRoot = path.resolve('/project');
    const fileAbs = path.resolve('/elsewhere/foo.js');
    await expect(
      runUi5Lint({ projectRoot, file: fileAbs, execImpl: exec }),
    ).rejects.toThrow(Ui5LintFileOutsideProjectError);
  });

  // V1.3.1-2 Problem 3 witness: a hung ui5lint must not freeze the run.
  // runUi5Lint builds its ExecOptions with no `timeout` on master, so the
  // subprocess is unbounded. V1.3.1-3 adds UI5LINT_TIMEOUT_MS.
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
    await runUi5Lint({ projectRoot: '/p', file: 'webapp/Component.js', execImpl: exec });
    // Fails on master with `expected 'undefined' to be 'number'`.
    expect(typeof capturedOpts?.timeout).toBe('number');
  });
});
