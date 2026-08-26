/**
 * Bug 1 (V1.1-DIAGNOSIS.md §"Bug 1 — ui5lint refuses absolute paths") —
 * witness test.
 *
 * `src/verify/ui5lint.ts` forwards the caller-supplied `args.file` to the
 * `ui5lint` binary verbatim. Every runtime caller passes an **absolute**
 * path, but `@ui5/linter` requires paths relative to the project root and
 * refuses anything else with:
 *
 *     Pattern must be relative to project's root folder. "<abs>" defines an
 *     absolute path.
 *
 * As a consequence every per-file baseline-ui5lint verify fails with that
 * exact diagnostic, yielding one `baseline-ui5lint` finding per scoped file.
 *
 * This test asserts the contract that V1.1-5 (Bug 1 fix) must satisfy:
 *
 *     The validator's run against the fixture must produce ZERO findings
 *     whose explanation contains "Pattern must be relative to project's
 *     root folder".
 *
 * After the fix the real ui5lint output may still flag a finding for the
 * fixture (e.g., the `sap.ui.getCore().getEventBus()` usage seeded in
 * Main.controller.js — see fixture README §"Seeded breaks"). That is fine:
 * we are not asserting "no ui5lint findings", only "no absolute-path
 * misconfiguration".
 */

import { describe, expect, test } from 'vitest';
import { E2E_REAL_ENABLED, readReport, reportExists } from './_shared.js';

const ABS_PATH_DIAGNOSTIC = "Pattern must be relative to project's root folder";

describe.skipIf(!E2E_REAL_ENABLED)('Bug 1 — ui5lint runs with project-relative paths', () => {
  test('report.json contains no finding with the absolute-path diagnostic', () => {
    expect(reportExists(), 'report.json not produced — see e2e-real setup.ts output').toBe(true);

    const report = readReport();
    const offenders: Array<{ file: string; checkId: string; snippet: string }> = [];
    for (const fileEntry of report.files) {
      for (const finding of fileEntry.findings) {
        // `explanation` only exists on the no-fix branch of Finding; on the
        // fix branch the diagnostic could not arise (ui5lint failure cannot
        // produce a proposedFix). Read defensively to keep the test
        // resilient to future Finding-shape additions.
        const explanation =
          'explanation' in finding && typeof finding.explanation === 'string'
            ? finding.explanation
            : '';
        const message = typeof finding.message === 'string' ? finding.message : '';
        const blob = `${explanation}\n${message}`;
        if (blob.includes(ABS_PATH_DIAGNOSTIC)) {
          offenders.push({
            file: fileEntry.file,
            checkId: finding.checkId,
            snippet: blob.slice(0, 200),
          });
        }
      }
    }
    expect(
      offenders,
      `expected zero findings with absolute-path diagnostic; ` +
        `found ${offenders.length}:\n${JSON.stringify(offenders.slice(0, 5), null, 2)}`,
    ).toEqual([]);
  });
});
