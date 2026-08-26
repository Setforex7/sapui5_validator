/**
 * V1.3.1-3 — unit coverage for the batched baseline-lint path
 * (`src/verify/baseline-lint.ts`): O(N/chunk) subprocess fan-out, `-f json`
 * parsing, `filePath` normalisation, and the tool-failure → `unattributable`
 * policy.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  BASELINE_LINT_CHUNK_SIZE,
  BaselineLintPathOutsideProjectError,
  runBaselineLint,
} from '../../src/verify/baseline-lint.js';
import type { ExecImpl, ExecResult } from '../../src/util/exec.js';

const PROJECT_ROOT = path.resolve('baseline-lint-fixture-root');

interface FakeExecCall {
  readonly binary: string;
  readonly args: readonly string[];
  readonly timeout?: number;
}

/** A `-f json` lint report for `errorCount` errors on a single file. */
function jsonReport(
  filePath: string,
  errorCount: number,
  opts: { warningCount?: number; fatalErrorCount?: number } = {},
): string {
  const messages = [];
  for (let i = 0; i < errorCount; i += 1) {
    messages.push({
      ruleId: 'fake-rule',
      severity: 2,
      line: i + 1,
      column: 1,
      message: `error ${i + 1} in ${filePath}`,
    });
  }
  return JSON.stringify([
    {
      filePath,
      messages,
      errorCount,
      warningCount: opts.warningCount ?? 0,
      fatalErrorCount: opts.fatalErrorCount ?? 0,
    },
  ]);
}

function makeFakeExec(
  responder: (binary: string, files: readonly string[]) => Partial<ExecResult>,
): { exec: ExecImpl; calls: FakeExecCall[] } {
  const calls: FakeExecCall[] = [];
  const exec: ExecImpl = async (binary, args = [], options = {}) => {
    calls.push({
      binary,
      args: [...args],
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    });
    const files = args.filter((a) => a !== '-f' && a !== 'json' && a !== '--');
    const r = responder(binary, files);
    return {
      ok: r.ok ?? true,
      stdout: r.stdout ?? '[]',
      stderr: r.stderr ?? '',
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs ?? 1,
    };
  };
  return { exec, calls };
}

function absFiles(...rel: readonly string[]): string[] {
  return rel.map((r) => path.join(PROJECT_ROOT, r));
}

describe('runBaselineLint — chunking', () => {
  test('collapses an N-file scope to ceil(N / chunk-size) subprocesses per linter', async () => {
    const total = BASELINE_LINT_CHUNK_SIZE * 2 + 7; // 207 files → 3 chunks
    const files = absFiles(
      ...Array.from({ length: total }, (_, i) => `webapp/controller/F${i}.js`),
    );
    const { exec, calls } = makeFakeExec(() => ({ exitCode: 0, stdout: '[]' }));
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files,
      eslintEnabled: true,
      execImpl: exec,
    });
    const ui5Calls = calls.filter((c) => c.binary === 'ui5lint');
    const esCalls = calls.filter((c) => c.binary === 'eslint');
    expect(ui5Calls).toHaveLength(3);
    expect(esCalls).toHaveLength(3);
    // Each chunk passes `-f json` plus its slice of paths — never a bare run.
    for (const c of ui5Calls) {
      expect(c.args.slice(0, 2)).toEqual(['-f', 'json']);
      expect(c.args.length).toBeGreaterThan(2);
    }
    const lastChunkPaths = ui5Calls[2]!.args.length - 2;
    expect(lastChunkPaths).toBe(7);
    // The subprocess is bounded (Problem 3 timeout flows through).
    expect(typeof ui5Calls[0]?.timeout).toBe('number');
  });

  test('an empty scope runs no subprocess at all', async () => {
    const { exec, calls } = makeFakeExec(() => ({ exitCode: 0, stdout: '[]' }));
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: [],
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ failures: [], unattributable: [] });
  });
});

describe('runBaselineLint — -f json parsing & per-file attribution', () => {
  test('a clean scope yields no failures and no unattributable', async () => {
    const { exec } = makeFakeExec(() => ({ exitCode: 0, stdout: '[]' }));
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toEqual([]);
    expect(result.unattributable).toEqual([]);
  });

  test('a file with errorCount > 0 becomes a per-file failure with a rendered explanation', async () => {
    const { exec } = makeFakeExec((binary) =>
      binary === 'ui5lint'
        ? { exitCode: 1, stdout: jsonReport('webapp/controller/App.controller.js', 2) }
        : { exitCode: 0, stdout: '[]' },
    );
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toHaveLength(1);
    const f = result.failures[0]!;
    expect(f.step).toBe('ui5lint');
    expect(f.file).toBe('webapp/controller/App.controller.js');
    expect(f.explanation).toContain('webapp/controller/App.controller.js');
    expect(f.explanation).toContain('error 1 in');
    expect(f.explanation).toContain('error 2 in');
  });

  test('warnings alone (errorCount 0) do not fail the baseline', async () => {
    const { exec } = makeFakeExec((binary) =>
      binary === 'ui5lint'
        ? {
            exitCode: 0,
            stdout: jsonReport('webapp/view/App.view.xml', 0, { warningCount: 3 }),
          }
        : { exitCode: 0, stdout: '[]' },
    );
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/view/App.view.xml'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toEqual([]);
    expect(result.unattributable).toEqual([]);
  });

  test('fatalErrorCount > 0 fails the baseline even when errorCount is 0', async () => {
    const { exec } = makeFakeExec((binary) =>
      binary === 'ui5lint'
        ? {
            exitCode: 1,
            stdout: jsonReport('webapp/controller/App.controller.js', 0, {
              fatalErrorCount: 1,
            }),
          }
        : { exitCode: 0, stdout: '[]' },
    );
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.step).toBe('ui5lint');
  });
});

describe('runBaselineLint — filePath normalisation', () => {
  test('ui5lint OS-native relative paths and eslint absolute paths both normalise to project-relative POSIX', async () => {
    const ctrlAbs = path.join(PROJECT_ROOT, 'webapp', 'controller', 'App.controller.js');
    const { exec } = makeFakeExec((binary) => {
      if (binary === 'ui5lint') {
        // ui5lint echoes OS-native (backslash) project-relative paths.
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              filePath: 'webapp\\controller\\App.controller.js',
              messages: [{ severity: 2, line: 1, column: 1, message: 'native-sep' }],
              errorCount: 1,
              warningCount: 0,
              fatalErrorCount: 0,
            },
          ]),
        };
      }
      // eslint emits absolute paths.
      return {
        exitCode: 1,
        stdout: JSON.stringify([
          {
            filePath: ctrlAbs,
            messages: [{ severity: 2, line: 2, column: 3, message: 'absolute' }],
            errorCount: 1,
            warningCount: 0,
            fatalErrorCount: 0,
          },
        ]),
      };
    });
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: [ctrlAbs],
      eslintEnabled: true,
      execImpl: exec,
    });
    const ui5 = result.failures.find((f) => f.step === 'ui5lint');
    const es = result.failures.find((f) => f.step === 'eslint');
    expect(ui5?.file).toBe('webapp/controller/App.controller.js');
    expect(es?.file).toBe('webapp/controller/App.controller.js');
  });
});

// SEC-4 (V1.8) — defense-in-depth `--` end-of-options before the path list, so
// a `-`-leading path is never read as a flag. Only eslint honours `--` while
// keeping file targeting; ui5lint must NOT receive it (it would lint the whole
// project). Fails on revert: drop the terminator and eslint's args lose `--`.
describe('runBaselineLint — SEC-4 end-of-options terminator', () => {
  test('eslint receives `-f json --` before paths; ui5lint receives no `--`', async () => {
    const seen: Record<string, string[]> = { ui5lint: [], eslint: [] };
    const exec: ExecImpl = async (binary, args = []) => {
      seen[binary] = [...args];
      return { ok: true, stdout: '[]', stderr: '', exitCode: 0, durationMs: 1 };
    };
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(seen['eslint']?.slice(0, 3)).toEqual(['-f', 'json', '--']);
    expect(seen['eslint']).toContain('webapp/controller/App.controller.js');
    // ui5lint must keep its bare positional — `--` would defeat per-file scoping.
    expect(seen['ui5lint']?.slice(0, 2)).toEqual(['-f', 'json']);
    expect(seen['ui5lint']).not.toContain('--');
  });
});

describe('runBaselineLint — eslint scope', () => {
  test('eslint receives only JS files; ui5lint receives every in-scope file', async () => {
    const files = absFiles(
      'webapp/controller/App.controller.js',
      'webapp/view/App.view.xml',
      'webapp/test/unit/App.qunit.js',
    );
    const seen: Record<string, string[]> = { ui5lint: [], eslint: [] };
    const { exec } = makeFakeExec((binary, passed) => {
      seen[binary] = passed.map((p) => p.replace(/\\/g, '/'));
      return { exitCode: 0, stdout: '[]' };
    });
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files,
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(seen['ui5lint']).toEqual([
      'webapp/controller/App.controller.js',
      'webapp/view/App.view.xml',
      'webapp/test/unit/App.qunit.js',
    ]);
    // The .view.xml is excluded — eslint cannot lint XML.
    expect(seen['eslint']).toEqual([
      'webapp/controller/App.controller.js',
      'webapp/test/unit/App.qunit.js',
    ]);
  });

  test('eslintEnabled: false runs ui5lint only', async () => {
    const { exec, calls } = makeFakeExec(() => ({ exitCode: 0, stdout: '[]' }));
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: false,
      execImpl: exec,
    });
    expect(calls.map((c) => c.binary)).toEqual(['ui5lint']);
  });
});

// SEC-6 (V1.8) — the baseline path normaliser must fail closed on a `..`
// escape, parity with verify/ui5lint.ts's toProjectRelativePosix. The
// normalised value becomes Finding.file (a write path), so an escape is a
// containment gap. Fails on revert: drop the guard and toRelPosix returns
// `../outside/evil.js` instead of throwing.
describe('runBaselineLint — SEC-6 path-escape guard', () => {
  test('an in-scope file path outside the project root is refused', async () => {
    const outside = path.resolve(PROJECT_ROOT, '..', 'outside', 'evil.js');
    const { exec } = makeFakeExec(() => ({ exitCode: 0, stdout: '[]' }));
    await expect(
      runBaselineLint({
        projectRoot: PROJECT_ROOT,
        files: [outside],
        eslintEnabled: false,
        execImpl: exec,
      }),
    ).rejects.toThrow(BaselineLintPathOutsideProjectError);
  });

  test('a linter-echoed filePath that escapes the project root is refused', async () => {
    const outside = path.resolve(PROJECT_ROOT, '..', 'outside', 'evil.js');
    const { exec } = makeFakeExec((binary) =>
      binary === 'ui5lint'
        ? {
            exitCode: 1,
            stdout: JSON.stringify([
              {
                filePath: outside,
                messages: [{ severity: 2, line: 1, column: 1, message: 'escaped' }],
                errorCount: 1,
                warningCount: 0,
                fatalErrorCount: 0,
              },
            ]),
          }
        : { exitCode: 0, stdout: '[]' },
    );
    await expect(
      runBaselineLint({
        projectRoot: PROJECT_ROOT,
        files: absFiles('webapp/controller/App.controller.js'),
        eslintEnabled: false,
        execImpl: exec,
      }),
    ).rejects.toThrow(BaselineLintPathOutsideProjectError);
  });

  test('an ordinary in-project path is unaffected (no over-blocking)', async () => {
    const { exec } = makeFakeExec(() => ({ exitCode: 0, stdout: '[]' }));
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: false,
      execImpl: exec,
    });
    expect(result).toEqual({ failures: [], unattributable: [] });
  });
});

describe('runBaselineLint — tool failure → unattributable', () => {
  test('a timeout (exitCode -1) routes that linter to unattributable, never "all clean"', async () => {
    const { exec } = makeFakeExec((binary) =>
      binary === 'ui5lint'
        ? { ok: false, exitCode: -1, stdout: '', stderr: 'timed out' }
        : { exitCode: 0, stdout: '[]' },
    );
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toEqual([]);
    expect(result.unattributable).toHaveLength(1);
    expect(result.unattributable[0]?.step).toBe('ui5lint');
    expect(result.unattributable[0]?.stderr).toContain('timed out');
  });

  test('an eslint exit-2 config error (no parseable JSON) routes to unattributable', async () => {
    const { exec } = makeFakeExec((binary) =>
      binary === 'eslint'
        ? {
            ok: false,
            exitCode: 2,
            stdout: '',
            stderr: 'Oops! Something went wrong! Invalid eslint config.',
          }
        : { exitCode: 0, stdout: '[]' },
    );
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toEqual([]);
    expect(result.unattributable).toEqual([
      {
        step: 'eslint',
        stderr: 'Oops! Something went wrong! Invalid eslint config.',
      },
    ]);
  });

  test('unparseable stdout on a zero exit is still a tool failure, not "all clean"', async () => {
    const { exec } = makeFakeExec((binary) =>
      binary === 'ui5lint'
        ? { exitCode: 0, stdout: 'not json at all' }
        : { exitCode: 0, stdout: '[]' },
    );
    const result = await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.js'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(result.failures).toEqual([]);
    expect(result.unattributable).toHaveLength(1);
    expect(result.unattributable[0]?.step).toBe('ui5lint');
  });
});

describe('V1.9 G2-03/G2-05 — TS eslint scope widening + ui5lint lints .ts', () => {
  test('tsEslint:true → .ts is included in the eslint scope (but .d.ts is not)', async () => {
    const { exec, calls } = makeFakeExec(() => ({ ok: true, exitCode: 0, stdout: '[]' }));
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.ts', 'webapp/env.d.ts'),
      eslintEnabled: true,
      tsEslint: true,
      execImpl: exec,
    });
    const eslintCall = calls.find((c) => c.binary === 'eslint');
    expect(eslintCall).toBeDefined();
    const argStr = (eslintCall?.args ?? []).join(' ');
    expect(argStr).toContain('webapp/controller/App.controller.ts');
    // ambient declarations are not eslint targets (mirror of discovery excludes)
    expect(argStr).not.toContain('env.d.ts');
  });

  test('default (tsEslint omitted) → .ts is dropped from eslint; no eslint subprocess', async () => {
    const { exec, calls } = makeFakeExec(() => ({ ok: true, exitCode: 0, stdout: '[]' }));
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.ts'),
      eslintEnabled: true,
      execImpl: exec,
    });
    expect(calls.some((c) => c.binary === 'ui5lint')).toBe(true);
    // eslintFiles is empty (the .ts is dropped) → lintOne short-circuits, no call.
    expect(calls.some((c) => c.binary === 'eslint')).toBe(false);
  });

  test('G2-05 — ui5lint lints a .ts file as-is (the adapter passes the path through)', async () => {
    const { exec, calls } = makeFakeExec(() => ({ ok: true, exitCode: 0, stdout: '[]' }));
    await runBaselineLint({
      projectRoot: PROJECT_ROOT,
      files: absFiles('webapp/controller/App.controller.ts'),
      eslintEnabled: false,
      execImpl: exec,
    });
    const ui5 = calls.find((c) => c.binary === 'ui5lint');
    expect(ui5).toBeDefined();
    expect((ui5?.args ?? []).join(' ')).toContain('webapp/controller/App.controller.ts');
  });
});
