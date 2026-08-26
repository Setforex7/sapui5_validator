/**
 * R1.3 (AUDIT §5.6b) — exit-code discipline in `src/cli.ts`.
 *
 * `process.exit()` immediately after a report write can drop buffered pipe
 * output — truncating `--json` stdout in the primary CI mode. The command
 * actions must set `process.exitCode` and return so Node flushes and exits
 * naturally.
 *
 * Witness 1 pins the done-when criterion at the source level: no
 * `process.exit(` call may exist in cli.ts at all (every site there either
 * follows a report/stdout write or shares the action-callback shape).
 * Witness 2 proves propagation by effect: a real CLI process driven through
 * the cheapest non-zero path exits — does not hang — with the code carried
 * by `process.exitCode`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = process.cwd();

describe('cli exit-code discipline (R1.3)', () => {
  test('src/cli.ts contains no process.exit() call', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');
    expect(source).not.toMatch(/process\.exit\(/);
  });

  test('a non-zero exit code set via process.exitCode propagates to the OS', () => {
    // `generate --qunit-only --opa5-only` hits the mutually-exclusive-flags
    // guard before any project/tooling access, so this runs anywhere. If the
    // action forgot to set exitCode the process would exit 0; if an open
    // handle kept the loop alive it would hang into the spawn timeout.
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(REPO_ROOT, 'src', 'cli.ts'),
        'generate',
        '--qunit-only',
        '--opa5-only',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toMatch(/mutually exclusive/);
    expect(result.status).toBe(1);
  }, 90_000);
});
