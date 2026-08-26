/**
 * R2.6(b) witnesses (AUDIT §5.8d) — direct unit tests for `util/exec.ts`,
 * the subprocess seam under EVERY external tool invocation (ui5lint,
 * eslint, karma, the `claude` binary). Untested until now, although the
 * whole failure-classification stack leans on its exact shape:
 *
 *   - `exitCode: -1` is the spawn-failure / kill / timeout contract that
 *     `classifyKarmaFailure` maps to `runner-unavailable` and that
 *     `isProcessKill` (binary-runner) maps to `ClaudeProcessKilledError`.
 *     An execa major bump that changed the timeout/kill surface would
 *     silently reroute timeouts into refinement burn — these tests pin it.
 *
 * All children are real `node -e` subprocesses (cross-platform, no shell),
 * so the pins hold against the REAL execa behaviour, not a stub.
 */

import { describe, expect, test } from 'vitest';
import { exec } from '../../src/util/exec.js';

const NODE = process.execPath;

describe('exec — exit-code mapping (R2.6b)', () => {
  test('exit 0 → ok: true, exitCode 0', async () => {
    const r = await exec(NODE, ['-e', 'process.exit(0)']);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test('non-zero exit → ok: false, the exact code preserved', async () => {
    const r = await exec(NODE, ['-e', 'process.exit(3)']);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  test('stdout/stderr are captured; the final newline is NOT stripped', async () => {
    // stripFinalNewline: false is load-bearing: karma output parsing is
    // line-anchored (R2.1b) and a stripped trailing newline would change
    // the last line's shape.
    const r = await exec(NODE, [
      '-e',
      'process.stdout.write("out\\n"); process.stderr.write("err\\n");',
    ]);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
  });

  test('input option pipes to the child stdin', async () => {
    const r = await exec(
      NODE,
      ['-e', 'process.stdin.pipe(process.stdout);'],
      { input: 'hello-stdin' },
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hello-stdin');
  });
});

describe('exec — timeout and kill classification (R2.6b)', () => {
  test('timeout ⇒ ok: false, exitCode -1 — the exact shape runner-unavailable depends on', async () => {
    // A karma subprocess that hangs past KARMA_TIMEOUT_MS surfaces through
    // this arm; classifyKarmaFailure maps exitCode < 0 with no markers to
    // `runner-unavailable` (never a quarantine). 60s child, 1s ceiling.
    const r = await exec(
      NODE,
      ['-e', 'setTimeout(function () {}, 60000);'],
      { timeout: 1000 },
    );
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(-1);
    // The child was killed after ~1s, not awaited for 60s.
    expect(r.durationMs).toBeLessThan(30_000);
  });

  test('abort signal ⇒ ok: false, exitCode -1 (same kill contract)', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await exec(
      NODE,
      ['-e', 'setTimeout(function () {}, 60000);'],
      { signal: controller.signal },
    );
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(-1);
    expect(r.durationMs).toBeLessThan(30_000);
  });

  test('spawn failure (missing binary) ⇒ ok: false, non-zero exit, EMPTY stdout, message in stderr', async () => {
    // Platform nuance, pinned as observed: on Windows execa surfaces a missing
    // binary through a cmd shim (exitCode 1, "is not recognized" on stderr),
    // whereas on Linux `reject: false` RESOLVES with no exit code and an EMPTY
    // stderr STREAM (the ENOENT text is on `result.shortMessage`). `exec()` now
    // falls that message back into `stderr` for the no-exit-code case, so the
    // reason is present cross-platform — this is what makes the
    // `stderr.length > 0` assertion below hold on Linux as well as Windows.
    // NOTE: on Windows this assertion stays green even if that fallback is
    // reverted (the cmd shim already populates stderr) — the Linux/CI leg is the
    // only one that fails-on-revert. The load-bearing classification contract is
    // still: ok false, non-zero exitCode, EMPTY stdout — exactly
    // `isProcessKill`'s second branch (non-zero exit with empty stdout), so a
    // missing `claude` binary is classified as a kill, never as malformed output.
    const r = await exec('sapui5-validator-no-such-binary-xyz', ['--version']);
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
