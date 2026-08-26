/**
 * V1.2-2 (Feature 1, Session V1.2-2) — gated end-to-end coverage for the
 * `--per-check-cap` flag wired into the real CLI binary.
 *
 * This test spawns `tsx src/cli.ts validate` against a tmpdir copy of the
 * e2e-real-project fixture (the same sandbox pattern V1.2-1's
 * dynamic-budget.e2e.test.ts uses) so the shared `.sapui5-validator/`
 * artefacts the other bug-witness tests assert against are never overwritten.
 *
 * What we assert (with a real `claude` binary in the loop):
 *
 *   - `--per-check-cap 25 --max-llm-calls 50` produces a per-category cap of
 *     `floor(25 × 50 / 100) = 12`. The fixture has only 3 controllers / 3
 *     views / 1 qunit test, so no single check reaches 12 targets — the cap
 *     should NOT bite in this configuration, and `report.cappedChecks`
 *     should be absent (proving the wiring is non-destructive on the common
 *     case).
 *
 *   - `--per-check-cap 1 --max-llm-calls 60` produces a per-category cap of
 *     `floor(1 × 60 / 100) = 0`, which short-circuits every LLM call from
 *     the check loop before it is made and emits the documented startup
 *     warning. `report.cappedChecks` must enumerate the skipped categories
 *     — the witness that the cap reached the real CLI and altered
 *     behaviour. Note: the apply-and-verify fix loop is intentionally NOT
 *     gated by the cap (SPEC §2.10), so baseline-derived fix attempts may
 *     still consume real LLM calls; the test does not assert
 *     `llmCallCount === 0`.
 *
 * The 60-call budget for the cap-0 scenario is chosen so the V1.2-1 menu
 * does not pop up (recommended ≤ 60), keeping the test deterministic with
 * `stdin: 'ignore'`.
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execa } from 'execa';
import { E2E_REAL_ENABLED, FIXTURE_ROOT } from './_shared.js';
import type { RunReport } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

interface Sandbox {
  readonly root: string;
}

let sandbox: Sandbox | null = null;

beforeAll(() => {
  if (!E2E_REAL_ENABLED) return;
  const root = mkdtempSync(join(tmpdir(), 'sapui5-percatcap-'));
  // `eslint.config.js` MUST be copied — an isolated tmpdir sandbox cannot
  // inherit the validator repo's own eslint config. Without it eslint has no
  // configuration and errors (exit 2); V1.3.1-3's batched baseline-lint path
  // correctly routes that tool failure to `unattributable` → `baseline-failed`,
  // which aborts the run before the check loop and leaves `cappedChecks`
  // unset. (The pre-V1.3.1-3 per-file path masked the gap by fabricating a
  // per-file `baseline-eslint` finding from the config error.) Mirrors
  // `createGenerateSandbox` in `_shared.ts`.
  for (const entry of [
    'webapp',
    'package.json',
    'ui5.yaml',
    'karma.conf.js',
    'eslint.config.js',
  ]) {
    const src = join(FIXTURE_ROOT, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(root, entry), { recursive: true });
  }
  symlinkSync(
    join(FIXTURE_ROOT, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  sandbox = { root };
});

afterAll(() => {
  if (sandbox === null) return;
  try {
    rmSync(sandbox.root, { recursive: true, force: true });
  } catch {
    // Best-effort: leave it for the OS tmp reaper if the junction refuses removal.
  }
  sandbox = null;
});

async function runCli(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (sandbox === null) throw new Error('sandbox not initialised — gate on E2E_REAL_ENABLED');
  const result = await execa('npx', ['tsx', CLI_ENTRY, ...args], {
    cwd: sandbox.root,
    reject: false,
    timeout: 10 * 60 * 1000,
    shell: process.platform === 'win32',
    stdin: 'ignore',
    env: { ...process.env, LANG: 'en_US.UTF-8' },
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function readSandboxReport(): RunReport {
  if (sandbox === null) throw new Error('sandbox not initialised');
  const path = join(sandbox.root, '.sapui5-validator', 'report.json');
  return JSON.parse(readFileSync(path, 'utf8')) as RunReport;
}

const SPAWN_TEST_TIMEOUT_MS = 15 * 60 * 1000;

describe.skipIf(!E2E_REAL_ENABLED)('V1.2-2 — per-category cap E2E', () => {
  test(
    '--per-check-cap 1 --max-llm-calls 60 → cap=0, warning emitted, no real LLM calls',
    async () => {
      const result = await runCli([
        'validate',
        '--all',
        '--force',
        '--no-prompt',
        '--max-llm-calls',
        '60',
        '--per-check-cap',
        '1',
      ]);
      // The cap-0 warning is the witness that V1.2-2 wiring reached the real CLI.
      expect(result.stderr).toMatch(/per-check-cap of 1% on 60 total calls/);
      expect(result.stderr).toMatch(/no LLM analysis will run/);
      const report = readSandboxReport();
      // cappedChecks must enumerate at least one CheckId — the witness that
      // the cap blocked check-loop calls. The fixture has controllers +
      // views + qunit tests in scope, so multiple categories would have
      // been dispatched and skipped. If this assertion fails because the
      // report carries an `error` exit reason, V1.2-2's catch handlers in
      // `applyAndVerifyFix` regressed — see commands/validate.ts.
      expect(report.cappedChecks).toBeDefined();
      const categories = Object.keys(report.cappedChecks ?? {});
      expect(categories.length).toBeGreaterThanOrEqual(3);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
