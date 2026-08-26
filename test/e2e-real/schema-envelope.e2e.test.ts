/**
 * Bug 3 (V1.1-DIAGNOSIS.md §"Bug 3 — Systematic schema validation failure") —
 * witness test.
 *
 * `claude -p --output-format json` emits a structured envelope
 *   `{ type, subtype, is_error, result, ... }`
 * where `result` is a STRING containing the model's actual response
 * (which, for our checks, is itself a JSON document `{"findings":[…]}`).
 *
 * V1's `BinaryRunner.run` `JSON.parse`s the envelope but then hands the
 * raw stdout to `safeJson(result.raw, findingsSchema)` in `_shared.ts`,
 * which re-parses the same envelope and validates it against the
 * findings schema. The envelope has no top-level `findings` key, so zod
 * rejects every call with:
 *
 *     Schema validation failed: [{"code":"invalid_type","expected":"array",
 *     "received":"undefined","path":["findings"],"message":"Required"}]
 *
 * In the original real run that surfaced this bug, 48 of 50 LLM calls
 * failed with that exact message — making every semantic check useless.
 *
 * This test asserts the contract that V1.1-8 (Bug 3 fix) must satisfy:
 *
 *   1. report.json contains ZERO findings whose explanation contains
 *      "Schema validation failed".
 *   2. report.llmCallCount > 0 (so we are actually asserting on real
 *      calls, not on a budget-exhausted-before-first-call run).
 *
 * Today this fails for whichever Bug-3-impacted call ran first, because
 * the validator surfaces every schema mismatch through `malformedFinding`
 * with `explanation: "Schema validation failed: …"`.
 */

import { describe, expect, test } from 'vitest';
import { E2E_REAL_ENABLED, readReport, reportExists } from './_shared.js';

const SCHEMA_FAILED_RX = /Schema validation failed/i;

describe.skipIf(!E2E_REAL_ENABLED)('Bug 3 — envelope is unwrapped before schema validation', () => {
  test('report.llmCallCount > 0 (real calls executed against the fixture)', () => {
    expect(reportExists(), 'report.json not produced — see e2e-real setup.ts output').toBe(true);
    const report = readReport();
    expect(
      report.llmCallCount,
      `expected at least one real LLM call against the fixture; got 0. ` +
        `exitReason=${JSON.stringify(report.exitReason)}`,
    ).toBeGreaterThan(0);
  });

  test('report.json contains no finding with "Schema validation failed"', () => {
    expect(reportExists()).toBe(true);
    const report = readReport();
    const offenders: Array<{ checkId: string; file: string; snippet: string }> = [];
    for (const fileEntry of report.files) {
      for (const finding of fileEntry.findings) {
        const explanation =
          'explanation' in finding && typeof finding.explanation === 'string'
            ? finding.explanation
            : '';
        const message = typeof finding.message === 'string' ? finding.message : '';
        const blob = `${explanation}\n${message}`;
        if (SCHEMA_FAILED_RX.test(blob)) {
          offenders.push({
            checkId: finding.checkId,
            file: fileEntry.file,
            snippet: blob.slice(0, 200),
          });
        }
      }
    }
    expect(
      offenders,
      `expected zero "Schema validation failed" findings; ` +
        `got ${offenders.length}:\n${JSON.stringify(offenders.slice(0, 5), null, 2)}`,
    ).toEqual([]);
  });
});
