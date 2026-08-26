/**
 * R2.6(a) witness (AUDIT §5.8a) — the FIRST automated e2e-real
 * `--concurrency` run. The V1.6 pool/lane invariants were proven with fakes
 * and injected delays (test/integration/generate.test.ts) plus two manual
 * cap_try data points; nothing repeatable exercised them against the real
 * toolchain (real `claude`, real karma-ui5 + headless Chrome, real
 * testsuite.qunit.html mutations). Every R2 change leans on that foundation
 * — this run pins it.
 *
 * Runs `generate --all --qunit-only --concurrency 2` on a sandbox copy of
 * the bundled fixture (testsuite-require discovery — the lane-safe mode, so
 * concurrency is HONOURED, not silently degraded). Three uncovered
 * controllers (App, Details, Settings) flow through the 2-worker pool.
 *
 * What is asserted, and why it is the honest observable set:
 *   1. Concurrency was actually exercised: the serial-fallback note is NOT
 *      emitted (a vacuous serial run would pass every other assertion).
 *   2. Deterministic report order: `generatedTests[]` lists candidates in
 *      candidate order (App, Details, Settings), not completion order —
 *      the pool's per-slot result contract against real, racy timings.
 *   3. Lane-serialised registration integrity: testsuite.qunit.html ends up
 *      with ALL generated module ids exactly once and the pre-existing Main
 *      entry intact. The registration mutations are read-modify-write on
 *      one shared file; only the verify lane's mutual exclusion keeps
 *      concurrent workers from losing entries.
 *   4. Verify-then-accept held end-to-end: every entry `passed` and the run
 *      exits 0 against the real toolchain.
 * Direct observation of karma-run non-overlap is not possible from outside
 * a green run (no instrumentation in production output, by design); the
 * fake-based integration tests pin that timing invariant (verify peak = 1).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  createGenerateSandbox,
  type CliRunResult,
  type GenerateSandbox,
} from './_shared.js';

/**
 * V1.9.5 (INF-1) — a lint-clean twin of the committed fixture's
 * `Main.controller.js`, seeded over the sandbox copy in `beforeAll`.
 *
 * WHY: the committed Main carries a deliberately ui5lint-RED seed
 * (`sap.ui.getCore().getEventBus()` — no-globals + no-deprecated-api ×2) as
 * INPUT for the validate witnesses. `generate --all`'s baseline lints every
 * in-scope file INCLUDING covered controllers (`baselineFiles` in
 * generate.ts), and generate refuses outright on ANY baseline finding
 * (SPEC §2.3) — so an unpatched pristine copy exits `baseline-failed` before
 * the pool ever starts. Historically this spec only passed by ACCIDENT of
 * ordering: pre-V1.9.5 the shared validate run applied its LLM fixes to the
 * IN-REPO fixture before this sandbox copied it, so the copy was lint-green
 * — a hidden coupling to LLM nondeterminism (a rate-limited validate run
 * silently broke the precondition). The INF-1 sandbox migration severed that
 * coupling; this seed replaces it with a deterministic one, following the
 * seed-your-own-precondition pattern of generate-baseline-red.e2e.test.ts.
 *
 * The twin is code-identical to the committed file except the one red line
 * (the seeded-break block comments are trimmed): the EventBus is obtained via
 * the already-imported `sap/ui/core/EventBus` module. The missing-teardown / no-direct-dom / unhandled-promise seeds are
 * Claude-check input, invisible to ui5lint/eslint, and stay intact; the
 * existing `Main.controller.qunit.js` (module-load assertion) stays green,
 * so Main remains a COVERED controller and the candidate set stays
 * App/Details/Settings.
 */
const LINT_CLEAN_MAIN_CONTROLLER_JS = `sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/EventBus"
], function (Controller, EventBus) {
  "use strict";

  return Controller.extend("e2e.real.project.controller.Main", {

    onInit: function () {
      // SEEDED BREAK (missing-teardown), lint-clean variant: subscribes via
      // the imported EventBus module (no ui5lint-red global/deprecated call)
      // and still never unsubscribes in an onExit.
      var oBus = EventBus.getInstance();
      oBus.subscribe("navigation", "refresh", this._onNavigationRefresh, this);
    },

    _onNavigationRefresh: function (sChannel, sEvent, oData) {
      this._lastRefresh = oData;
    },

    onPress: function () {
      // SEEDED BREAK (no-direct-dom) — Claude-check input, ui5lint-invisible.
      var oNode = document.getElementById("__xmlview0--submitBtn");
      if (oNode) {
        oNode.setAttribute("data-pressed", "true");
      }
    },

    onLoadData: function () {
      // SEEDED BREAK (unhandled-promise-rejection) — Claude-check input.
      this._fetchData();
    },

    _fetchData: async function () {
      var oResponse = await fetch("/api/items");
      if (!oResponse.ok) {
        throw new Error("Failed to load: " + oResponse.status);
      }
      var oData = await oResponse.json();
      this.getView().getModel().setProperty("/items", oData);
    }
  });
});
`;

const TESTSUITE_REL = 'webapp/test/testsuite.qunit.html';
const EXPECTED_SOURCE_ORDER = [
  'webapp/controller/App.controller.js',
  'webapp/controller/Details.controller.js',
  'webapp/controller/Settings.controller.js',
] as const;
const EXPECTED_MODULES = [
  'e2e/real/project/test/unit/controller/App.controller.qunit',
  'e2e/real/project/test/unit/controller/Details.controller.qunit',
  'e2e/real/project/test/unit/controller/Settings.controller.qunit',
] as const;
const PRE_EXISTING_MODULE = 'e2e/real/project/test/unit/controller/Main.controller.qunit';

// 3 real generations + karma verifies; the suite's standard ceiling.
const RUN_TIMEOUT_MS = 12 * 60_000;

let sandbox: GenerateSandbox | null = null;
let runResult: CliRunResult | null = null;

beforeAll(async () => {
  if (!E2E_REAL_ENABLED) return;
  sandbox = createGenerateSandbox('sapui5-gen-conc-');
  // The sandbox copies webapp/ AFTER setup.ts seeded the gitignored Bug-2 /
  // Bug-4 inputs into the fixture; `--all` would otherwise pick the ~1 MB
  // oversized-input.js up as a FOURTH candidate (argv-guard no-output entry
  // — its own witness, not this one). Remove both seeds so the candidate
  // set is the committed fixture's three controllers, deterministically.
  for (const seedRel of ['webapp/util/oversized-input.js', 'webapp/util/dummy-vendor.min.js']) {
    rmSync(sandbox.path(seedRel), { force: true });
  }
  // Make the sandbox baseline-lint-green deterministically (see the
  // LINT_CLEAN_MAIN_CONTROLLER_JS doc comment): `--all` baselines the covered
  // Main too, and its committed ui5lint-red seed would abort the run with
  // `baseline-failed` before the pool starts.
  writeFileSync(
    sandbox.path('webapp/controller/Main.controller.js'),
    LINT_CLEAN_MAIN_CONTROLLER_JS,
    'utf8',
  );
  runResult = await sandbox.run([
    'generate',
    '--all',
    '--qunit-only',
    '--concurrency',
    '2',
    '--force',
  ]);
}, RUN_TIMEOUT_MS);

afterAll(() => {
  sandbox?.remove();
  sandbox = null;
  runResult = null;
});

describe.skipIf(!E2E_REAL_ENABLED)('R2.6(a) — generate --concurrency 2 against the real toolchain', () => {
  test('concurrency was honoured (no serial-fallback note) and the run exited 0', () => {
    if (runResult === null) throw new Error('run did not execute');
    expect(
      runResult.stderr,
      'the fixture is testsuite-require (lane-safe); a serial fallback here ' +
        'would mean the witness silently stopped exercising the pool',
    ).not.toContain('Running serially to preserve verify-then-accept');
    expect(
      runResult.exitCode,
      `generate exited ${runResult.exitCode}\nstderr:\n${runResult.stderr}`,
    ).toBe(0);
  });

  test('all three candidates passed, in deterministic candidate order (not completion order)', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    expect(sandbox.reportExists(), 'report.json not written').toBe(true);
    const report = sandbox.readReport();
    expect(report.exitReason.kind).toBe('success');
    expect(report.generatedTests.map((g) => g.sourceFile)).toEqual([
      ...EXPECTED_SOURCE_ORDER,
    ]);
    for (const entry of report.generatedTests) {
      expect(
        entry.status,
        `expected '${entry.sourceFile}' to verify-then-accept against the ` +
          `real toolchain; got '${entry.status}'`,
      ).toBe('passed');
    }
  });

  test('lane-serialised registration: testsuite.qunit.html carries every module exactly once, Main intact', () => {
    if (sandbox === null) throw new Error('sandbox not initialised');
    const html = readFileSync(sandbox.path(TESTSUITE_REL), 'utf8');
    for (const moduleId of [...EXPECTED_MODULES, PRE_EXISTING_MODULE]) {
      const occurrences = html.split(`"${moduleId}"`).length - 1;
      expect(
        occurrences,
        `expected exactly one registration of "${moduleId}" in ` +
          `${TESTSUITE_REL} (a lost or duplicated entry means the lane did ` +
          `not serialise the read-modify-write registration mutations)`,
      ).toBe(1);
    }
  });
});
