/**
 * R4.3 (AUDIT §5.8e) — the REAL-OS-KILL half of the split process-kill
 * witness.
 *
 * Post-B1 (V1.5), the original oversized-input witnesses stopped observing
 * a real kill: the pre-spawn argv guard refuses any prompt over
 * `CLAUDE_ARGV_LIMIT` (32,500 bytes — budgeted UNDER the Windows
 * 32,767-char `CreateProcess` ceiling), so an input large enough to die on
 * spawn is now always intercepted first with the synthetic exit code -2.
 * That is the guard working as designed — and it makes a CLI-driven real
 * kill structurally unreachable: any prompt that passes the guard also
 * spawns fine. (The AUDIT marked this collapse *(inferred)*; the R2.1/R2.2
 * gated runs confirmed it — both old witnesses observed only -2.)
 *
 * So this variant observes the kill one layer down, with nothing faked:
 * it spawns the REAL `claude` binary through `BinaryRunner` and lets the
 * OS genuinely terminate the live child mid-flight (execa's kill on a
 * timeout that is far shorter than any real API roundtrip). The child
 * really starts, really dies, and the result flows through the REAL
 * classification path: `exec` maps the killed process to `exitCode: -1`,
 * `isProcessKill` catches it BEFORE any parse, the reformat retry is
 * skipped (Bug 6), and `ClaudeProcessKilledError` (not
 * `MalformedLlmOutputError`) surfaces with the `llm-error-*.txt` capture
 * on disk. exitCode -1 is observable again — the other half of the split
 * (`process-kill.e2e.test.ts`, `generate-process-kill.e2e.test.ts`)
 * pins the argv-guard's -2 refusal.
 *
 * The only test-injected piece is an `execImpl` pass-through that ADDS a
 * timeout to the real `exec` call; the spawn, the binary, the kill, and
 * every line of classification code are production-real.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  BinaryRunner,
  ClaudeProcessKilledError,
} from '../../src/claude/binary-runner.js';
import { buildClaudeArgs } from '../../src/claude/runner.js';
import { exec, type ExecOptions } from '../../src/util/exec.js';
import { E2E_REAL_ENABLED } from './_shared.js';

/**
 * Far below any real `claude -p` roundtrip (binary boot alone exceeds it),
 * far above the spawn itself — the child is reliably alive when the OS
 * kills it.
 */
const KILL_AFTER_MS = 2_000;
const RUN_TIMEOUT_MS = 60_000;

let errorDir: string;
let caught: unknown = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  errorDir = mkdtempSync(join(tmpdir(), 'sapui5-real-kill-'));
  const runner = new BinaryRunner({
    errorOutputDir: errorDir,
    // Pass-through to the REAL exec + REAL `claude` binary; the added
    // timeout is what lets the OS kill the genuinely-running child.
    execImpl: (file: string, args: readonly string[] = [], options: ExecOptions = {}) =>
      exec(file, args, { ...options, timeout: KILL_AFTER_MS }),
  });
  try {
    await runner.run(
      buildClaudeArgs({
        prompt:
          'Take your time and think step by step, then reply with a JSON ' +
          'object {"answer": <the 20th prime number>}.',
        cwd: process.cwd(),
      }),
    );
  } catch (err) {
    caught = err;
  }
}, RUN_TIMEOUT_MS);

afterAll(() => {
  if (!E2E_REAL_ENABLED) return;
  try {
    rmSync(errorDir, { recursive: true, force: true });
  } catch {
    // best-effort tmp cleanup
  }
});

describe.skipIf(!E2E_REAL_ENABLED)('R4.3 — a real OS kill of the real claude binary observes exitCode -1', () => {
  test('the killed call classifies as ClaudeProcessKilledError with exitCode -1 (never malformed output)', () => {
    expect(
      caught,
      'expected runner.run() to reject — the real claude child cannot ' +
        `complete a roundtrip inside ${KILL_AFTER_MS}ms`,
    ).not.toBeNull();
    expect(
      caught,
      `expected ClaudeProcessKilledError, got: ${String(caught)}`,
    ).toBeInstanceOf(ClaudeProcessKilledError);
    if (caught instanceof ClaudeProcessKilledError) {
      expect(
        caught.exitCode,
        'a genuine OS kill surfaces through exec as -1 (the argv guard, ' +
          'by contrast, stamps -2 before any spawn)',
      ).toBe(-1);
      expect(caught.message).toMatch(/exited before producing output/i);
      expect(caught.message).not.toMatch(/malformed/i);
    }
  });

  test('the llm-error capture records the -1 kill (single attempt — no reformat retry burned)', () => {
    const captures = readdirSync(errorDir).filter(
      (n) => n.startsWith('llm-error-') && n.endsWith('.txt'),
    );
    expect(
      captures.length,
      `expected exactly one llm-error capture in ${errorDir} (the kill ` +
        'short-circuits BEFORE the reformat retry — Bug 6), found: ' +
        JSON.stringify(captures),
    ).toBe(1);
    const first = captures[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      const body = readFileSync(join(errorDir, first), 'utf8');
      expect(body).toMatch(/exitCode:\s*-1/);
    }
    if (caught instanceof ClaudeProcessKilledError) {
      expect(existsSync(caught.errorFilePath)).toBe(true);
    }
  });
});
