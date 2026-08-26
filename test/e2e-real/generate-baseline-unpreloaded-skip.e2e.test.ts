/**
 * V1.4-4 / V1.4-11 — pre-flight-skip witness for the
 * `baseline-unpreloaded-libs` check (default opt-out path).
 *
 * A controller importing a UI5 library that the project's manifest does
 * not declare will hang karma-ui5 at `browserNoActivityTimeout` if a test
 * loads it. V1.4-4 prevents that proactively: the baseline graph sees the
 * undeclared import, the `baseline-unpreloaded-libs` finding fires against
 * `webapp/manifest.json`, and — when the user has NOT passed
 * `--auto-apply-baseline-fixes` — the generate loop records a
 * `status: 'skipped-baseline'` entry without calling Claude. The user is
 * told to re-run with the flag.
 *
 * Lib choice (V1.4-11). This witness imports `sap/f/library` — `sap.f` is
 * an OpenUI5 library the fixture's karma `ui5.url` CDN (sdk.openui5.org)
 * SERVES, so V1.4-10's CDN probe classifies it `cdnServed: true` → the
 * manifest-fix (skip) path. That makes the outcome deterministic in BOTH
 * network directions: online the probe gets a 200; offline it times out
 * and V1.4-10's conservative default ("uncertainty ⇒ served") lands on the
 * same path. The earlier incarnation of this test seeded
 * `sap/ui/export/Spreadsheet` — but `sap.ui.export` 404s on the OpenUI5
 * CDN, so V1.4-10 reclassified it to the stub path (not the skip path),
 * which made the old assertions both wrong and network-dependent. The
 * CDN-absent stub path is covered at the integration layer
 * (`test/integration/generate.test.ts` → V1.4-10 block, injected probe).
 *
 * The auto-apply happy path lives in
 * `generate-baseline-unpreloaded-apply.e2e.test.ts`.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

const RUN_TIMEOUT_MS = 12 * 60_000;

/**
 * A controller that imports `sap/f/library` — `sap.f` is the
 * CDN-served-but-unmanifested gap the V1.4-4 baseline check flags against
 * the fixture's manifest (which declares only `sap.m` + `sap.ui.core`).
 */
const SAP_F_CONTROLLER = `sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/f/library"
], function (Controller, fioriLibrary) {
  "use strict";

  return Controller.extend("e2e.real.project.controller.Reports", {
    getDefaultLayout: function () {
      return fioriLibrary.LayoutType.OneColumn;
    }
  });
});
`;

let sandbox: GenerateSandbox | null = null;
let runResult: CliRunResult | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createGenerateSandbox('sapui5-gen-unpreload-skip-');
  // Seed the gap controller. The fixture's manifest.json is intentionally
  // LEFT AS-IS (no `sap.f` under sap.ui5.dependencies.libs) — that absence
  // is what the V1.4-4 baseline check fires on.
  writeFileSync(
    sandbox.path('webapp', 'controller', 'Reports.controller.js'),
    SAP_F_CONTROLLER,
    'utf8',
  );
  // No `--auto-apply-baseline-fixes`: the default UX surfaces the finding
  // and skips the affected controller rather than mutating the manifest.
  runResult = await sandbox.run([
    'generate',
    'webapp/controller/Reports.controller.js',
    '--qunit-only',
    '--force',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

describe.skipIf(!E2E_REAL_ENABLED)(
  'V1.4-4 — baseline-unpreloaded-libs pre-flight skip (default opt-out path)',
  () => {
    test('the affected controller is recorded with status: skipped-baseline (not quarantined)', () => {
      if (sandbox === null || runResult === null) {
        throw new Error('run did not execute');
      }
      expect(sandbox.reportExists(), 'report.json not written').toBe(true);
      const report = sandbox.readReport();
      const reportsEntry = report.generatedTests.find((t) =>
        t.sourceFile.endsWith('Reports.controller.js'),
      );
      expect(reportsEntry, 'no generatedTests entry for Reports.controller.js').toBeDefined();
      expect(
        reportsEntry?.status,
        `expected V1.4-4 pre-flight-skip status 'skipped-baseline'; ` +
          `a CDN-served gap (sap.f) is manifest-fixable, so without ` +
          `--auto-apply-baseline-fixes the controller is skipped before any LLM call.`,
      ).toBe('skipped-baseline');
    });

    test('no LLM call is burned on the skipped controller', () => {
      if (sandbox === null) throw new Error('sandbox not initialised');
      const report = sandbox.readReport();
      // V1.4-4 pre-flight-skip path: zero LLM calls. The baseline check is
      // deterministic; the affected controller is skipped before generation.
      expect(
        report.llmCallCount,
        `expected zero LLM calls on the V1.4-4 pre-flight-skip path.`,
      ).toBe(0);
    });

    test('the baseline finding names the unpreloaded library and proposes a manifest fix', () => {
      if (sandbox === null) throw new Error('sandbox not initialised');
      const report = sandbox.readReport();
      const manifestEntry = report.files.find(
        (f) => f.file === 'webapp/manifest.json',
      );
      expect(
        manifestEntry,
        'no manifest.json entry in report.files (baseline check did not fire)',
      ).toBeDefined();
      const finding = manifestEntry?.findings.find(
        (f) => f.checkId === 'baseline-unpreloaded-libs',
      );
      expect(finding, 'no baseline-unpreloaded-libs finding').toBeDefined();
      // sap.f is CDN-served → the finding carries a manifest auto-fix the
      // user can apply with --auto-apply-baseline-fixes.
      expect(finding?.proposedFix).not.toBeNull();
      expect(finding?.message).toContain('sap.f');
    });
  },
);
