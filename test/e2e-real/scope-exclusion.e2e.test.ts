/**
 * Bug 4 (V1.1-DIAGNOSIS.md §"Bug 4 — Vendor and minified files included in
 * scope") — witness test.
 *
 * `CONTROLLER_JS_EXCLUDE` in `src/commands/validate.ts` only excludes
 * `webapp/test/**`, `webapp/Component.js`, and `webapp/Component.ts`. It
 * does not exclude `*.min.js` or conventional third-party paths
 * (`vendor/`, `thirdparty/`). The original real run that surfaced this bug
 * scanned a 600KB `webapp/util/xlsx.full.min.js` four times before the
 * subprocess died.
 *
 * This test seeds a small minified blob at
 * `webapp/util/dummy-vendor.min.js` (via [setup.ts](./setup.ts), kept out
 * of git via the fixture's `.gitignore`) and asserts the contract that
 * V1.1-6 (Bug 4 fix) must satisfy:
 *
 *     The validator's per-file scope MUST NOT include any path matching
 *     `webapp/**\/*.min.js`. The report's `files[]` array therefore
 *     contains zero entries for the seeded `dummy-vendor.min.js`.
 *
 * Today the bug is observable: the report contains an entry for the file
 * (one or more LLM-error / baseline-ui5lint findings, depending on which
 * other bugs fire first).
 */

import { describe, expect, test } from 'vitest';
import { E2E_REAL_ENABLED, readReport, reportExists } from './_shared.js';

const SEEDED_VENDOR_REL = 'webapp/util/dummy-vendor.min.js';

describe.skipIf(!E2E_REAL_ENABLED)('Bug 4 — *.min.js excluded from scope', () => {
  test(`report.json has no files[] entry for the seeded ${SEEDED_VENDOR_REL}`, () => {
    expect(reportExists(), 'report.json not produced — see e2e-real setup.ts output').toBe(true);

    const report = readReport();
    const hits = report.files.filter((f) => f.file === SEEDED_VENDOR_REL);
    expect(
      hits,
      `expected zero report entries for ${SEEDED_VENDOR_REL}; ` +
        `got ${hits.length}:\n${JSON.stringify(hits, null, 2)}`,
    ).toEqual([]);
  });

  test('no finding anywhere in the report references the seeded *.min.js path', () => {
    expect(reportExists()).toBe(true);
    const report = readReport();
    const refs: Array<{ checkId: string; container: string; finding: string }> = [];
    for (const f of report.files) {
      for (const finding of f.findings) {
        if (finding.file === SEEDED_VENDOR_REL) {
          refs.push({ checkId: finding.checkId, container: f.file, finding: finding.file });
        }
      }
    }
    expect(
      refs,
      `expected zero findings targeting ${SEEDED_VENDOR_REL}; ` +
        `got ${refs.length}: ${JSON.stringify(refs.slice(0, 5), null, 2)}`,
    ).toEqual([]);
  });
});
