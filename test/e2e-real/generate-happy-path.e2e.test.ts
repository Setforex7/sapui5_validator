/**
 * V1.3-2 — happy-path witness for the `generate` command.
 *
 * Runs `generate webapp/controller/App.controller.js --qunit-only` against an
 * isolated sandbox copy of the e2e-real fixture. A single controller plus
 * `--qunit-only` bounds the cost to the README's $0.10–$0.40.
 *
 * The contract pinned here is the SPEC §1.2 verify-then-accept guarantee for
 * a generated QUnit test:
 *
 *   1. the test file lands at the standard layout path
 *      `webapp/test/unit/controller/App.controller.qunit.js`;
 *   2. its module id is registered in `webapp/test/testsuite.qunit.html`'s
 *      `sap.ui.require([...])` array so karma (karma-ui5 html mode) actually
 *      executes it — without registration the karma verify step passes
 *      vacuously and an unexecuted test is reported "passed";
 *   3. the run exits 0.
 *
 * On `master`, assertion (2) fails deterministically: `generate` writes
 * nothing to `testsuite.qunit.html` (V1.3-DIAGNOSIS §4 item 1, BLOCKER-class).
 * V1.3-4 closes that gap and turns this into a true verify-then-accept test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

const APP_TEST_REL = 'webapp/test/unit/controller/App.controller.qunit.js';
const APP_TEST_MODULE = 'e2e/real/project/test/unit/controller/App.controller.qunit';
const TESTSUITE_REL = 'webapp/test/testsuite.qunit.html';

const RUN_TIMEOUT_MS = 12 * 60_000;

let sandbox: GenerateSandbox | null = null;
let runResult: CliRunResult | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createGenerateSandbox('sapui5-gen-happy-');
  runResult = await sandbox.run([
    'generate',
    'webapp/controller/App.controller.js',
    '--qunit-only',
    '--force',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

describe.skipIf(!E2E_REAL_ENABLED)('V1.3-2 — generate happy path (QUnit, single controller)', () => {
  test('writes the QUnit test file at the standard layout path', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    expect(
      existsSync(sandbox.path(APP_TEST_REL)),
      `expected the generated QUnit test at ${APP_TEST_REL}`,
    ).toBe(true);
  });

  test('registers the generated module in testsuite.qunit.html (V1.3-4 witness)', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    const html = readFileSync(sandbox.path(TESTSUITE_REL), 'utf8');
    expect(
      html,
      `expected ${TESTSUITE_REL} to register the generated module ` +
        `"${APP_TEST_MODULE}" in its sap.ui.require([...]) array so karma ` +
        `actually executes it. On master, generate never writes to ` +
        `testsuite.qunit.html (V1.3-DIAGNOSIS §4 item 1).`,
    ).toContain(APP_TEST_MODULE);
  });

  test('exits 0', () => {
    if (runResult === null) throw new Error('run did not execute');
    expect(
      runResult.exitCode,
      `generate exited ${runResult.exitCode}\nstderr:\n${runResult.stderr}`,
    ).toBe(0);
  });
});
