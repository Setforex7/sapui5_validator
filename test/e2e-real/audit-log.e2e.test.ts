/**
 * Bug 5 (V1.1-DIAGNOSIS.md §"Bug 5 — Audit log written empty") — witness test.
 *
 * Today the orchestrator constructs `AuditLog` and calls `init()` (which
 * creates the three subdirectories) but never invokes `writePrompt`,
 * `writeResponse`, or `writeVerify`. The result is three empty directories
 * after every real run. This test asserts the contract that V1.1-4 (Bug 5
 * fix) and V1.1-8 (Bug 3 fix, unblocks LLM-call success) must satisfy:
 *
 *   - prompts/   contains at least one file (one per LLM call)
 *   - responses/ contains at least one file (one per LLM call)
 *   - verify/    contains at least one file (at least one verify dump from
 *                a fix-loop iteration — ui5lint, eslint, or karma)
 *
 * The single shared `validate --all` run happens in
 * [test/e2e-real/setup.ts](./setup.ts); this file only reads from disk.
 *
 * Failure progression expected across the V1.1 fix sessions:
 *   - Today  (V1.1-3):  all three assertions FAIL — dirs are empty.
 *   - V1.1-4 (Bug 5):   prompts/ + responses/ pass; verify/ may still fail
 *                       because no fix-loop iteration runs while Bug 3 is
 *                       open (every LLM call dies in schema validation, so
 *                       no findings reach the fix loop).
 *   - V1.1-8 (Bug 3):   verify/ assertion finally passes once real findings
 *                       can be produced.
 */

import { describe, expect, test } from 'vitest';
import { E2E_REAL_ENABLED, PATHS, lastRunSummary, listDir } from './_shared.js';

describe.skipIf(!E2E_REAL_ENABLED)('Bug 5 — audit log written for every LLM call', () => {
  test('.sapui5-validator/last-run/prompts/ contains at least one file', () => {
    const files = listDir(PATHS.promptsDir);
    expect(
      files.length,
      `expected at least one prompt dump; got 0.\nLast-run summary:\n${lastRunSummary()}`,
    ).toBeGreaterThan(0);
  });

  test('.sapui5-validator/last-run/responses/ contains at least one file', () => {
    const files = listDir(PATHS.responsesDir);
    expect(
      files.length,
      `expected at least one response dump; got 0.\nLast-run summary:\n${lastRunSummary()}`,
    ).toBeGreaterThan(0);
  });

  test('.sapui5-validator/last-run/verify/ contains at least one file', () => {
    const files = listDir(PATHS.verifyDir);
    expect(
      files.length,
      `expected at least one verify dump; got 0.\nLast-run summary:\n${lastRunSummary()}`,
    ).toBeGreaterThan(0);
  });
});
