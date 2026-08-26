/**
 * R1.4 (AUDIT §5.6d) — D1 wiring on validate's third LLM path.
 *
 * The real `claude -p` surfaces a 429 as a THROWN `ClaudeApiError`. The
 * check path and the generate path already retry it on the SPEC §2.12
 * backoff schedule (V1.5 D1); `requestRefinedFix` did not, so a transient
 * 429 mid-fix bypassed backoff and landed as a reverted fix + exit 1.
 * These witnesses drive `applyAndVerifyFix` (which owns the refinement
 * call) through both 429 shapes:
 *
 *   - thrown 429 once → backoff, retry, fix applied   (RED without R1.4)
 *   - result-shaped 429 once → same                   (pre-R1.4 control)
 *   - thrown 429 persisting → RateLimitExhaustedError + file reverted
 *                                                      (RED without R1.4)
 *
 * V1.7 session (ii): the sleeps run on an injected instant recording
 * `Sleeper` (the existing `withRateLimitBackoff` seam, threaded through
 * `FixContext.sleeper`) instead of real/fake timers. The recorded delays
 * pin the SPEC §2.12 schedule explicitly, and the witnesses are
 * deterministic under any suite load — the real-timer version timed out
 * under the e2e-real gate's concurrency (project memory).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ClaudeApiError,
  RateLimitExhaustedError,
} from '../../src/claude/binary-runner.js';
import { CallBudget, RATE_LIMIT_BACKOFF_MS, type Sleeper } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { applyAndVerifyFix } from '../../src/commands/validate.js';
import type { Finding } from '../../src/types.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

const ORIGINAL = 'sap.ui.define([], function () { /* original */ });\n';
const BROKEN_FIX = '// broken first fix\n';
const REFINED_FIX = '// refined good fix\n';
const TARGET_REL = 'webapp/controller/Main.controller.js';

const VERIFY_OK: VerifyResult = { ok: true, steps: [], feedbackForLlm: '' };
const VERIFY_FAIL: VerifyResult = {
  ok: false,
  steps: [],
  failedStep: 'ui5lint',
  feedbackForLlm: 'ui5lint: broken fix',
};

function thrown429(): never {
  throw new ClaudeApiError(
    'cid-429',
    'error',
    true,
    '429',
    'API Error: 429 Too Many Requests',
    '/tmp/llm-error-cid-429.txt',
  );
}

describe('applyAndVerifyFix — 429 backoff on the refinement path (R1.4)', () => {
  let projectRoot: string;
  let sleptMs: number[];
  const instantSleeper: Sleeper = async (ms) => {
    sleptMs.push(ms);
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sapui5-validator-r14-'));
    mkdirSync(join(projectRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(projectRoot, TARGET_REL), ORIGINAL, 'utf8');
    sleptMs = [];
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function fixContext(runner: FakeClaudeRunner) {
    // Attempt 1 (the proposedFix) fails verify; the refined content passes.
    const verifyFn = async ({ file }: { file: string }): Promise<VerifyResult> =>
      readFileSync(file, 'utf8') === REFINED_FIX ? VERIFY_OK : VERIFY_FAIL;
    const finding: Finding = {
      checkId: 'no-direct-dom',
      file: TARGET_REL,
      message: 'direct DOM access',
      source: 'check',
      proposedFix: { newFileContent: BROKEN_FIX },
    };
    return {
      finding,
      projectRoot,
      runner,
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      verifyFn,
      sleeper: instantSleeper,
    };
  }

  test('a thrown 429 mid-refinement backs off and the retried fix is applied', async () => {
    let refinementCalls = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refinementCalls += 1;
          if (refinementCalls === 1) thrown429();
          return { raw: JSON.stringify({ newFileContent: REFINED_FIX }) };
        },
      },
    ]);

    const outcome = await applyAndVerifyFix(fixContext(runner));

    expect(outcome).toEqual({ kind: 'applied', attempts: 2 });
    expect(refinementCalls).toBe(2); // first 429, then the backed-off retry
    // Exactly one backoff sleep fired, with the schedule's first delay.
    expect(sleptMs).toEqual([RATE_LIMIT_BACKOFF_MS[0]]);
    expect(readFileSync(join(projectRoot, TARGET_REL), 'utf8')).toBe(REFINED_FIX);
  });

  test('control: a result-shaped 429 mid-refinement already backed off pre-R1.4', async () => {
    let refinementCalls = 0;
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => {
          refinementCalls += 1;
          if (refinementCalls === 1) {
            return { ok: false, raw: '', stderr: '429 too many requests', exitCode: 1 };
          }
          return { raw: JSON.stringify({ newFileContent: REFINED_FIX }) };
        },
      },
    ]);

    const outcome = await applyAndVerifyFix(fixContext(runner));

    expect(outcome).toEqual({ kind: 'applied', attempts: 2 });
    expect(refinementCalls).toBe(2);
    expect(sleptMs).toEqual([RATE_LIMIT_BACKOFF_MS[0]]);
  });

  test('a persistent thrown 429 exhausts the schedule: RateLimitExhaustedError, file reverted', async () => {
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.prompt.includes('did not pass verification'),
        response: () => thrown429(),
      },
    ]);

    await expect(applyAndVerifyFix(fixContext(runner))).rejects.toBeInstanceOf(
      RateLimitExhaustedError,
    );
    // The FULL SPEC §2.12 schedule was honoured before exhaustion.
    expect(sleptMs).toEqual([...RATE_LIMIT_BACKOFF_MS]);
    // The catch arm reverted the working tree before rethrowing — the
    // orchestrator then maps the error to the `rate-limited` exit reason
    // (pinned by the existing validate.test.ts rate-limit integrations).
    expect(readFileSync(join(projectRoot, TARGET_REL), 'utf8')).toBe(ORIGINAL);
  });
});
