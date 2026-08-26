/**
 * V1.9.8 Phase 1 — the PROMPT_VERSION builder-hash ratchet (CA-2).
 *
 * The detection cache keys on `PROMPT_VERSION` + the assembled prompt. A
 * semantic change to the batch prompt BUILDERS that leaves some prompts
 * textually identical (e.g. reordering check instructions, changing what a
 * check means without changing its wording for every input) would otherwise
 * serve stale findings from the old prompt regime. This test pins the content
 * hash of `src/checks/batch.ts`: ANY edit to that file fails here until a
 * conscious decision is recorded — bump `PROMPT_VERSION` if the change is
 * prompt-relevant (wording, instructions, output contract, embedded-content
 * framing), then re-pin; re-pin alone if it is provably prompt-irrelevant
 * (e.g. a comment). The failure message below restates this rule.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PROMPT_VERSION } from '../../src/checks/batch.js';

const BATCH_TS = join(process.cwd(), 'src', 'checks', 'batch.ts');

/** Pinned sha256 of src/checks/batch.ts at the last PROMPT_VERSION decision. */
const PINNED_HASH = '53e6df5f73f3fec843ec9a1d3c7441e77b1a0f4ad953bb3842d4818dff7105be';

describe('PROMPT_VERSION ratchet (V1.9.8 CA-2)', () => {
  test('PROMPT_VERSION is a positive integer', () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });

  test('batch.ts changed ⇒ decide whether PROMPT_VERSION must bump, then re-pin', () => {
    const hash = createHash('sha256')
      .update(readFileSync(BATCH_TS))
      .digest('hex');
    expect(
      hash,
      `src/checks/batch.ts changed (sha256 ${hash}, pinned ${PINNED_HASH}).\n` +
        `The detection cache keys on PROMPT_VERSION (currently ${PROMPT_VERSION}) — ` +
        `if your change is prompt-relevant (prompt wording, check instructions, ` +
        `output contract, embedded-content framing), BUMP PROMPT_VERSION so stale ` +
        `cached findings can never serve against the new prompts. If it is provably ` +
        `prompt-irrelevant (comments, types, dispatch mechanics), leave it. ` +
        `Either way, update PINNED_HASH in this test to record the decision.`,
    ).toBe(PINNED_HASH);
  });
});
