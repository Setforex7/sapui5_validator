/**
 * V1.4-4 / V1.4-11 — auto-apply happy-path witness for the
 * `baseline-unpreloaded-libs` check (`--auto-apply-baseline-fixes`).
 *
 * The companion `generate-baseline-unpreloaded-skip.e2e.test.ts` covers the
 * default opt-out path (surface + skip). This test covers the opt-in path:
 * when the user passes `--auto-apply-baseline-fixes`, the validator patches
 * `webapp/manifest.json` to declare the CDN-served gap lib, rebuilds the
 * project graph (so the controller is NO LONGER a gap), and proceeds to
 * generate + verify a real QUnit test against the now-preloadable library.
 *
 * Lib choice: `sap/f/library` (`sap.f`) — served by the fixture's OpenUI5
 * karma CDN, so V1.4-10's probe classifies it `cdnServed: true` (the
 * manifest-fixable path). The controller is deliberately trivial
 * (`getDefaultLayout` returns a `sap.f` enum value) so the generated test
 * is reliably passable once `sap.f` is preloaded — this exercises the
 * V1.4-4 auto-apply wiring end-to-end, not the LLM's test-writing skill.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

const RUN_TIMEOUT_MS = 12 * 60_000;

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
  sandbox = createGenerateSandbox('sapui5-gen-unpreload-apply-');
  writeFileSync(
    sandbox.path('webapp', 'controller', 'Reports.controller.js'),
    SAP_F_CONTROLLER,
    'utf8',
  );
  runResult = await sandbox.run([
    'generate',
    'webapp/controller/Reports.controller.js',
    '--qunit-only',
    '--force',
    '--auto-apply-baseline-fixes',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

describe.skipIf(!E2E_REAL_ENABLED)(
  'V1.4-4 — baseline-unpreloaded-libs auto-apply (--auto-apply-baseline-fixes)',
  () => {
    test('manifest.json is patched on disk to declare the CDN-served lib', () => {
      if (sandbox === null || runResult === null) {
        throw new Error('run did not execute');
      }
      const manifestRaw = readFileSync(
        sandbox.path('webapp', 'manifest.json'),
        'utf8',
      );
      const manifest = JSON.parse(manifestRaw) as {
        'sap.ui5'?: { dependencies?: { libs?: Record<string, unknown> } };
      };
      const libs = manifest['sap.ui5']?.dependencies?.libs ?? {};
      expect(
        Object.keys(libs),
        `expected sap.f declared after --auto-apply-baseline-fixes; libs=${JSON.stringify(libs)}`,
      ).toContain('sap.f');
    });

    test('the controller is NOT skipped — a real test is generated and passes', () => {
      if (sandbox === null) throw new Error('sandbox not initialised');
      const report = sandbox.readReport();
      const reportsEntry = report.generatedTests.find((t) =>
        t.sourceFile.endsWith('Reports.controller.js'),
      );
      expect(reportsEntry, 'no generatedTests entry for Reports.controller.js').toBeDefined();
      expect(
        reportsEntry?.status,
        `expected 'passed' after the manifest auto-fix preloaded sap.f; ` +
          `'skipped-baseline' would mean the post-fix graph rebuild did not clear the gap, ` +
          `'quarantined' would mean karma still could not load the lib.`,
      ).toBe('passed');
    });
  },
);
