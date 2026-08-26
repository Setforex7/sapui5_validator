/**
 * V1.9 TS-VERIFY / DEP-3 — the `tsc --noEmit` adapter witness.
 *
 * Pins: the invocation is `tsc --noEmit` (project subprocess, no file
 * positionals so the project's tsconfig drives the check), `preferLocal` (the
 * project-local tsc), and — DEP-3/HB-3 — the per-subprocess timeout. A spawn /
 * timeout maps to `exitCode: -1` → `ok: false` (a type-breaking or hung tsc
 * fails the verify step). No `typescript` is imported here — the binary is the
 * project's, resolved via exec.
 */

import { describe, expect, test } from 'vitest';
import type { ExecImpl, ExecOptions, ExecResult } from '../../src/util/exec.js';
import { runTsc, TSC_BINARY, TSC_TIMEOUT_MS } from '../../src/verify/tsc.js';

interface Call {
  file: string;
  args: readonly string[];
  opts: ExecOptions;
}

function recordingExec(result: Partial<ExecResult>): { impl: ExecImpl; calls: Call[] } {
  const calls: Call[] = [];
  const impl: ExecImpl = async (file, args = [], opts = {}) => {
    calls.push({ file, args, opts });
    return {
      ok: result.ok ?? true,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
      durationMs: result.durationMs ?? 1,
    };
  };
  return { impl, calls };
}

describe('runTsc — invocation shape (DEP-3)', () => {
  test('invokes `tsc --noEmit` with preferLocal and the per-subprocess timeout', async () => {
    const { impl, calls } = recordingExec({ ok: true, exitCode: 0 });
    const res = await runTsc({ projectRoot: '/proj', execImpl: impl });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(TSC_BINARY);
    expect(calls[0]?.args).toEqual(['--noEmit']);
    // No file positionals → the project's tsconfig.json drives the whole-project
    // type-check (passing a file would make tsc ignore tsconfig).
    expect(calls[0]?.args).not.toContain('--');
    expect(calls[0]?.opts.cwd).toBe('/proj');
    expect(calls[0]?.opts.preferLocal).toBe(true);
    expect(calls[0]?.opts.timeout).toBe(TSC_TIMEOUT_MS);
  });

  test('forwards an AbortSignal', async () => {
    const ac = new AbortController();
    const { impl, calls } = recordingExec({ ok: true });
    await runTsc({ projectRoot: '/p', execImpl: impl, signal: ac.signal });
    expect(calls[0]?.opts.signal).toBe(ac.signal);
  });

  test('a type error (non-zero exit) is reported as data, not thrown', async () => {
    const { impl } = recordingExec({
      ok: false,
      exitCode: 2,
      stdout: "webapp/controller/App.controller.ts(7,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    });
    const res = await runTsc({ projectRoot: '/p', execImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('TS2322');
  });

  test('DEP-3/HB-3: a timeout / spawn failure (exitCode -1) is a failed step', async () => {
    // `exec` maps a timeout-kill to exitCode -1; an unbounded/pathological tsc
    // must FAIL the step, never hang or be read as "clean".
    const { impl } = recordingExec({ ok: false, exitCode: -1, stderr: 'timed out' });
    const res = await runTsc({ projectRoot: '/p', execImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(-1);
  });
});
