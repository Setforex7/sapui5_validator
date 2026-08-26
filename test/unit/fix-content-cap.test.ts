/**
 * V1.9.4 (PERF-12) — refinement-prompt content byte-cap.
 *
 * `requestRefinedFix` embeds the file-under-fix verbatim. The file content is a
 * volatile payload — re-sent uncached on each retry — so a large source file
 * plus the ≤16 KiB verify feedback would multiply its input-token cost across
 * attempts (post-V1.9.6 the prompt travels on stdin, so the old
 * `CLAUDE_ARGV_LIMIT` argv ceiling no longer bounds it; the cap is now a
 * token-cost bound). The cap converts an oversized file into a *degraded*
 * attempt: it is run through the same `prepareFeedbackForPrompt` machinery and
 * the prompt is flagged so the model returns the corrected FULL file rather
 * than the partial view it sees.
 *
 * These witnesses pin three behaviours (revert any and they go RED):
 *   1. content over the cap → the prompt carries the "return the FULL file"
 *      truncation marker (the fail-on-revert guard for the marker);
 *   2. content at/under the cap → byte-identical embed, NO marker, NO
 *      `prepareFeedbackForPrompt` transformation (guards the size gate — without
 *      it, the karma-progress collapse would silently mangle a normal source
 *      file);
 *   3. after all attempts fail on the truncated path, the file is reverted to
 *      the byte-exact original (the PERF-12 revert guard for a bad partial).
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { applyAndVerifyFix, REFINE_CONTENT_CAP_BYTES } from '../../src/commands/validate.js';
import type { Finding } from '../../src/types.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

const ORIGINAL = 'sap.ui.define([], function () { /* original — äöü€ */ });';
const TARGET_REL = 'webapp/controller/Main.controller.js';
const TRUNCATION_MARKER = 'TRUNCATED to fit the prompt budget';
const FULL_FILE_INSTRUCTION = 'Return the corrected COMPLETE file';

const VERIFY_FAIL: VerifyResult = {
  ok: false,
  steps: [],
  failedStep: 'ui5lint',
  feedbackForLlm: 'ui5lint: broken fix',
};

// A benign payload comfortably past the cap. No ANSI, no `Executed N of M`, no
// stack-frame / `Error` lines → `prepareFeedbackForPrompt` performs a clean
// head/tail truncation (it never hoists or collapses anything here).
function oversizedContent(): string {
  const line = '  // padding line to exceed the refinement content byte cap ----------\n';
  const repeats = Math.ceil((REFINE_CONTENT_CAP_BYTES * 2) / Buffer.byteLength(line, 'utf8'));
  return `sap.ui.define([], function () {\n${line.repeat(repeats)}});\n`;
}

function finding(proposedFix: string): Finding {
  return {
    checkId: 'no-direct-dom',
    file: TARGET_REL,
    message: 'direct DOM access',
    source: 'check',
    proposedFix: { newFileContent: proposedFix },
  };
}

function refiningRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner([
    {
      match: (a) => a.prompt.includes('did not pass verification'),
      // Small, well-under-cap refined content for every refinement call.
      response: { raw: JSON.stringify({ newFileContent: '// refined fix\n' }) },
    },
  ]);
}

describe('applyAndVerifyFix — refinement content byte-cap (PERF-12)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sapui5-validator-perf12-'));
    mkdirSync(join(projectRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(projectRoot, TARGET_REL), ORIGINAL, 'utf8');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test('content over the cap → the refinement prompt carries the full-file truncation marker', async () => {
    const big = oversizedContent();
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(REFINE_CONTENT_CAP_BYTES);

    const runner = refiningRunner();
    // verifyFn always fails → exhausts all attempts, so every refinement call
    // fires. The FIRST refinement embeds `big` (the proposedFix) → marker.
    const outcome = await applyAndVerifyFix({
      finding: finding(big),
      projectRoot,
      runner,
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      verifyFn: async () => VERIFY_FAIL,
    });

    expect(outcome.kind).toBe('reverted');
    // The run-level counter saw exactly one truncation: the first refinement
    // embedded the oversized proposedFix; the second embedded the small refined
    // content (under the cap), so it did not truncate.
    expect(outcome.contentTruncations).toBe(1);
    const firstRefinement = runner.calls[0];
    expect(firstRefinement).toBeDefined();
    expect(firstRefinement?.prompt).toContain(TRUNCATION_MARKER);
    expect(firstRefinement?.prompt).toContain(FULL_FILE_INSTRUCTION);
    // The embedded content was actually shrunk to fit the cap (with headroom for
    // the marker + scaffolding), not sent whole.
    expect(Buffer.byteLength(firstRefinement?.prompt ?? '', 'utf8')).toBeLessThan(
      Buffer.byteLength(big, 'utf8'),
    );

    // PERF-12 revert guard: a bad partial still reverts to the byte-exact original.
    expect(readFileSync(join(projectRoot, TARGET_REL))).toEqual(Buffer.from(ORIGINAL, 'utf8'));
  });

  test('content at/under the cap → embedded byte-identical, no marker, no transformation', async () => {
    // Two `Executed N of M` lines: if the size gate were removed and
    // `prepareFeedbackForPrompt` ran on every file, its karma-progress collapse
    // would drop the FIRST one. Both surviving proves the raw embed.
    const small = [
      'sap.ui.define([], function () {',
      '  // Executed 1 of 2 setup steps',
      '  // Executed 2 of 2 setup steps',
      '});',
      '',
    ].join('\n');
    expect(Buffer.byteLength(small, 'utf8')).toBeLessThanOrEqual(REFINE_CONTENT_CAP_BYTES);

    const runner = refiningRunner();
    const outcome = await applyAndVerifyFix({
      finding: finding(small),
      projectRoot,
      runner,
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      // Fail once to trigger exactly one refinement embedding `small`, then pass.
      verifyFn: (() => {
        let n = 0;
        return async () => {
          n += 1;
          return n === 1 ? VERIFY_FAIL : { ok: true, steps: [], feedbackForLlm: '' };
        };
      })(),
    });

    // No truncation fired → the counter field is omitted entirely (never a 0).
    expect(outcome.contentTruncations).toBeUndefined();
    const refinement = runner.calls[0];
    expect(refinement).toBeDefined();
    expect(refinement?.prompt).toContain('Executed 1 of 2 setup steps');
    expect(refinement?.prompt).toContain('Executed 2 of 2 setup steps');
    expect(refinement?.prompt).not.toContain(TRUNCATION_MARKER);
    expect(refinement?.prompt).not.toContain(FULL_FILE_INSTRUCTION);
  });
});
