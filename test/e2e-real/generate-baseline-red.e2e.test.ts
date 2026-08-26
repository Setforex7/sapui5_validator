/**
 * V1.3-2 — baseline-red witness for the `generate` command.
 *
 * SPEC §2.3: `generate` must refuse to run when the existing test suite is
 * red, regardless of scope — "don't pile new tests onto a broken project".
 * The sandbox seeds one failing unit test and registers it in
 * `testsuite.qunit.html` so karma (karma-ui5 html mode) discovers and runs it,
 * making the existing suite red.
 *
 * Two scopes are exercised against that red suite:
 *
 *   - `--all`: `scope.qunitTest` is populated, so today's *conditional*
 *     baseline karma probe already runs. This already exits `baseline-failed`
 *     on `master`; the assertion is a regression guard.
 *   - single-controller (`webapp/controller/App.controller.js`):
 *     `scope.qunitTest` is empty, so today's conditional probe is skipped and
 *     `generate` proceeds onto the broken project — the V1.3-DIAGNOSIS Area 5
 *     gap. This assertion fails on `master` and passes once V1.3-6 makes the
 *     baseline karma probe unconditional.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
  type LooseRunReport,
} from './_shared.js';

const FAILING_TEST_REL = 'webapp/test/unit/controller/Failing.controller.qunit.js';
const TESTSUITE_REL = 'webapp/test/testsuite.qunit.html';
const RUN_TIMEOUT_MS = 25 * 60_000;

/** A unit test with an assertion that always fails — makes the suite red. */
const FAILING_TEST_JS = `sap.ui.define([], function () {
  "use strict";
  QUnit.module("seeded-failing-baseline");
  QUnit.test("intentionally failing baseline test (V1.3-2)", function (assert) {
    assert.ok(false, "seeded by generate-baseline-red.e2e.test.ts to make the suite red");
  });
});
`;

/** testsuite.qunit.html that registers both the original and the failing test. */
const TESTSUITE_WITH_FAILING = `<!DOCTYPE html>
<html>
<head>
  <title>QUnit test suite for e2e.real.project</title>
  <meta charset="utf-8">
  <script
    id="sap-ui-bootstrap"
    src="../resources/sap-ui-core.js"
    data-sap-ui-resourceroots='{ "e2e.real.project": "../" }'
    data-sap-ui-async="true"></script>
  <link rel="stylesheet" href="../resources/sap/ui/thirdparty/qunit-2.css" type="text/css" media="screen" />
  <script src="../resources/sap/ui/thirdparty/qunit-2.js"></script>
  <script src="../resources/sap/ui/qunit/qunit-junit.js"></script>
  <script>
    QUnit.config.autostart = false;
    sap.ui.require([
      "e2e/real/project/test/unit/controller/Main.controller.qunit",
      "e2e/real/project/test/unit/controller/Failing.controller.qunit"
    ], function () {
      QUnit.start();
    });
  </script>
</head>
<body>
  <div id="qunit"></div>
  <div id="qunit-fixture"></div>
</body>
</html>
`;

interface ScopeRun {
  readonly result: CliRunResult;
  readonly report: LooseRunReport;
}

let sandbox: GenerateSandbox | null = null;
let allScope: ScopeRun | null = null;
let singleScope: ScopeRun | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createGenerateSandbox('sapui5-gen-baseline-');
  writeFileSync(sandbox.path(FAILING_TEST_REL), FAILING_TEST_JS, 'utf8');
  writeFileSync(sandbox.path(TESTSUITE_REL), TESTSUITE_WITH_FAILING, 'utf8');

  // report.json is overwritten per run — read it before the next run starts.
  const allResult = await sandbox.run(['generate', '--all', '--qunit-only', '--force']);
  allScope = { result: allResult, report: sandbox.readReport() };

  const singleResult = await sandbox.run([
    'generate',
    'webapp/controller/App.controller.js',
    '--qunit-only',
    '--force',
  ]);
  singleScope = { result: singleResult, report: sandbox.readReport() };
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  allScope = null;
  singleScope = null;
});

describe.skipIf(!E2E_REAL_ENABLED)('V1.3-2 — generate refuses a red baseline suite', () => {
  test('--all scope: a red suite is refused with baseline-failed (regression guard)', () => {
    if (allScope === null) throw new Error('--all run did not execute');
    expect(
      allScope.report.exitReason.kind,
      `expected 'baseline-failed' for --all against a red suite; ` +
        `got '${allScope.report.exitReason.kind}'`,
    ).toBe('baseline-failed');
    expect(allScope.result.exitCode, 'baseline-failed must exit non-zero').not.toBe(0);
  });

  test('single-controller scope: a red suite is refused with baseline-failed (V1.3-6 witness)', () => {
    if (singleScope === null) throw new Error('single-controller run did not execute');
    expect(
      singleScope.report.exitReason.kind,
      `expected 'baseline-failed' for a single-controller scope against a ` +
        `red suite; got '${singleScope.report.exitReason.kind}'. On master ` +
        `the baseline karma probe is skipped when scope.qunitTest is empty ` +
        `(V1.3-DIAGNOSIS Area 5), so generate proceeds onto the broken suite.`,
    ).toBe('baseline-failed');
    expect(singleScope.result.exitCode, 'baseline-failed must exit non-zero').not.toBe(0);
  });
});
