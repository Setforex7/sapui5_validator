/**
 * R2.3(ii) (AUDIT §5.4) — validate's apply/verify loop revert guard.
 *
 * `applyAndVerifyFix` writes the proposed fix to the user's working tree
 * BEFORE verifying it. Pre-R2.3 only the recognised throw classes
 * (rate-limit / budget exhaustion) restored the original file; a THROWING
 * verifyFn — e.g. a ui5lint adapter error or (pre-R2.3(iii)) an audit-write
 * failure — escaped with the half-applied fix still on disk. These witnesses
 * prove the guard restores the BYTE-EXACT original on any throw, at any
 * attempt, and never masks the original error.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { applyAndVerifyFix } from '../../src/commands/validate.js';
import type { Finding } from '../../src/types.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

// Non-ASCII content + no trailing newline make "byte-exact" a real assertion:
// an encoding round-trip slip or an editor-style newline append would fail it.
const ORIGINAL = 'sap.ui.define([], function () { /* original — äöü€ */ });';
const BROKEN_FIX = '// broken fix attempt\n';
const TARGET_REL = 'webapp/controller/Main.controller.js';

const VERIFY_FAIL: VerifyResult = {
  ok: false,
  steps: [],
  failedStep: 'ui5lint',
  feedbackForLlm: 'ui5lint: broken fix',
};

describe('applyAndVerifyFix — revert guard on the throw path (R2.3 ii)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sapui5-validator-r23ii-'));
    mkdirSync(join(projectRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(projectRoot, TARGET_REL), ORIGINAL, 'utf8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function finding(): Finding {
    return {
      checkId: 'no-direct-dom',
      file: TARGET_REL,
      message: 'direct DOM access',
      source: 'check',
      proposedFix: { newFileContent: BROKEN_FIX },
    };
  }

  test('verifyFn throws on attempt 1 → original error propagates AND the file is byte-exact original', async () => {
    const boom = new Error('verify pipeline exploded mid-verify');
    const promise = applyAndVerifyFix({
      finding: finding(),
      projectRoot,
      runner: new FakeClaudeRunner([]),
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      verifyFn: async () => {
        throw boom;
      },
    });

    await expect(promise).rejects.toBe(boom);
    // Byte-exact restoration — raw Buffer compare, not a string/flag check.
    expect(readFileSync(join(projectRoot, TARGET_REL))).toEqual(
      Buffer.from(ORIGINAL, 'utf8'),
    );
  });

  test('verifyFn throws on attempt 2 (mid-loop, after a refinement) → file is byte-exact original', async () => {
    const boom = new Error('verify died on the second attempt');
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: { raw: JSON.stringify({ newFileContent: '// refined fix\n' }) },
      },
    ]);
    let verifyCalls = 0;
    const promise = applyAndVerifyFix({
      finding: finding(),
      projectRoot,
      runner,
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      verifyFn: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) return VERIFY_FAIL;
        throw boom;
      },
    });

    await expect(promise).rejects.toBe(boom);
    expect(verifyCalls).toBe(2);
    expect(readFileSync(join(projectRoot, TARGET_REL))).toEqual(
      Buffer.from(ORIGINAL, 'utf8'),
    );
  });
});
