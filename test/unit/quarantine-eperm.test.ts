/**
 * R2.3(iv) (AUDIT §5.7d/G9, Windows-real) — quarantine rename EPERM retry.
 *
 * On Windows an AV scanner / search indexer holding a transient handle on the
 * just-written test file surfaces as EPERM (or EBUSY) on the quarantine
 * `unlink+rename` pair. Pre-R2.3 that throw escaped `quarantine()` and
 * aborted the WHOLE run (pool `unexpected` → rethrow, no report entry). The
 * witness injects an EPERM-once rename fake and proves the quarantine still
 * completes; the control proves a persistent EPERM (a genuinely locked file)
 * still propagates rather than looping.
 *
 * Module-scoped `node:fs/promises` mock — keep this witness in its own file.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { generateAndVerify } from '../../src/generation/retry-loop.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

const renameFault = vi.hoisted(() => ({ failuresRemaining: 0, attempts: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (oldPath: string, newPath: string): Promise<void> => {
      renameFault.attempts += 1;
      if (renameFault.failuresRemaining > 0) {
        renameFault.failuresRemaining -= 1;
        const err: NodeJS.ErrnoException = new Error(
          `EPERM: operation not permitted, rename '${oldPath}' -> '${newPath}'`,
        );
        err.code = 'EPERM';
        throw err;
      }
      return real.rename(oldPath, newPath);
    },
  };
});

function failedVerify(): VerifyResult {
  return {
    ok: false,
    steps: [],
    failedStep: 'karma',
    feedbackForLlm: 'assertion failed',
  };
}

describe('quarantine — transient EPERM on unlink/rename is retried once (R2.3 iv)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-quarantine-eperm-'));
    mkdirSync(join(root, 'webapp', 'test', 'unit'), { recursive: true });
    renameFault.failuresRemaining = 0;
    renameFault.attempts = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runToQuarantine() {
    return generateAndVerify(
      {
        initialPrompt: 'Generate Locked',
        buildRefinementPrompt: () => 'refine',
        targetTestFileAbs: join(root, 'webapp', 'test', 'unit', 'Locked.qunit.js'),
      },
      {
        projectRoot: root,
        runner: new FakeClaudeRunner([
          { match: /./, response: { raw: JSON.stringify({ newFileContent: '// broken\n' }) } },
        ]),
        budget: new CallBudget({ maxCalls: 10 }),
        eslintEnabled: false,
        verifyFn: async () => failedVerify(),
      },
    );
  }

  test('EPERM once → the quarantine completes on the retry; run does not abort', async () => {
    renameFault.failuresRemaining = 1;

    const outcome = await runToQuarantine();

    expect(outcome.kind).toBe('quarantined');
    expect(renameFault.attempts).toBe(2); // EPERM, then the successful retry
    expect(
      existsSync(join(root, 'webapp', 'test', '_failing', 'Locked.failing.qunit.js')),
    ).toBe(true);
    expect(existsSync(join(root, 'webapp', 'test', 'unit', 'Locked.qunit.js'))).toBe(
      false,
    );
  });

  test('control: persistent EPERM (genuinely locked file) propagates after the single retry', async () => {
    renameFault.failuresRemaining = 99;

    await expect(runToQuarantine()).rejects.toMatchObject({ code: 'EPERM' });
    expect(renameFault.attempts).toBe(2); // exactly one retry — no loop
  });
});
