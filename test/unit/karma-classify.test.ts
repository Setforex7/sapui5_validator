/**
 * V1.3-5 — unit coverage for `classifyKarmaFailure` (SPEC §2.10 step 3).
 *
 * The classifier separates "the karma runner could not run" from "a test ran
 * and failed" so `generate`'s retry loop never refines a sound test against a
 * dead runner.
 *
 * The karma strings below are grounded in real output: markers 1-4 were
 * captured directly by running `karma start` against broken configs in the
 * e2e-real-project fixture during the V1.3-5 session; the browser-launch
 * cases (`(cannot start)`, `no usable sandbox`) follow karma's / Chrome's
 * documented launcher message format. None are invented stand-ins.
 */

import { describe, expect, test } from 'vitest';
import { libNameFor } from '../../src/project/lib-namespace.js';
import {
  classifyKarmaFailure,
  extractFailedModule,
  hasModuleLoadPattern,
  type KarmaFailureClass,
  type KarmaResult,
} from '../../src/verify/karma.js';

function karma(partial: Partial<KarmaResult>): KarmaResult {
  return {
    ok: false,
    stdout: '',
    stderr: '',
    exitCode: 1,
    durationMs: 5,
    testFiles: [],
    ...partial,
  };
}

describe('classifyKarmaFailure — runner-unavailable', () => {
  test('exitCode < 0 (exec.ts spawn-failure contract) → runner-unavailable', () => {
    expect(
      classifyKarmaFailure(karma({ exitCode: -1, stderr: 'spawn karma ENOENT' })),
    ).toBe('runner-unavailable');
  });

  test('unregistered browser launcher → runner-unavailable', () => {
    // Real karma output for the V1.3-2 witness's `browsers: ['Bogus']` config.
    const stdout =
      '21 05 2026 20:26:59.708:INFO [launcher]: Launching browsers Bogus with concurrency unlimited\n' +
      '21 05 2026 20:26:59.709:ERROR [launcher]: Cannot load browser "Bogus": it is not registered! Perhaps you are missing some plugin?\n' +
      '21 05 2026 20:26:59.709:ERROR [karma-server]: Error: Found 1 load error\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('config file that throws on load → runner-unavailable', () => {
    // Real karma output: a `require()` of a missing module inside the config.
    const stdout =
      '21 05 2026 20:27:30.634:ERROR [config]: Error in config file!\n' +
      " Error: Cannot find module 'this-module-does-not-exist-xyz'\n";
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('missing framework plugin (e.g. karma-ui5 absent) → runner-unavailable', () => {
    // Real karma output for an unregistered framework name.
    const stdout =
      '21 05 2026 20:28:27.393:ERROR [karma-server]: Server start failed on port 9876: ' +
      'Error: No provider for "framework:totally-bogus-framework"! ' +
      '(Resolving: framework:totally-bogus-framework)\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('browser binary will not start → runner-unavailable', () => {
    const stdout =
      'ERROR [launcher]: Cannot start ChromeHeadless\n' +
      'ERROR [launcher]: ChromeHeadless failed 2 times (cannot start). Giving up.\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('headless Chrome with no usable sandbox → runner-unavailable', () => {
    const stdout =
      'ERROR [launcher]: ChromeHeadless crashed: no usable sandbox! Update your kernel or see https://crbug.com/638180.\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('marker matching is case-insensitive and scans stderr too', () => {
    expect(
      classifyKarmaFailure(
        karma({ exitCode: 1, stdout: '', stderr: 'ERROR [CONFIG]: ERROR IN CONFIG FILE!' }),
      ),
    ).toBe('runner-unavailable');
  });
});

describe('(R2.1b) bootstrap markers are line-anchored to karma\'s own ERROR lines', () => {
  // AUDIT-v0.7.0 §5.3b — the old whole-haystack substring match admitted
  // forwarded browser console output and QUnit assertion text; a failing
  // test whose message merely contained a marker word aborted the ENTIRE
  // run as karma-unavailable. Markers now only match on karma's own
  // `ERROR [launcher|config|karma-server]` lines. These witnesses fail on
  // revert of the line anchoring.

  test('(R2.1b) assertion text containing a marker word → test-failure, NOT karma-unavailable', () => {
    // A genuine red test whose assertion message contains "no provider
    // for" — forwarded into karma's combined output by the reporter.
    const stdout =
      'INFO [launcher]: Starting browser ChromeHeadless\n' +
      'Chrome Headless 131.0.0.0 (Windows 10) Shop cart module FAILED\n' +
      "\tExpected dialog text to be 'no provider for cart service' but was ''\n" +
      'Chrome Headless 131.0.0.0 (Windows 10): Executed 3 of 3 (1 FAILED) (0.4 secs / 0.2 secs)\n' +
      'TOTAL: 1 FAILED, 2 SUCCESS\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe('test-failure');
  });

  test('(R2.1b) forwarded browser console LOG line containing a marker word → test-failure', () => {
    // karma forwards browser console output as `<Browser> LOG: '...'`
    // lines — they are not karma's own ERROR lines.
    const stdout =
      "Chrome Headless 131.0.0.0 (Windows 10) LOG: 'retrying: server start failed, will reconnect'\n" +
      'Chrome Headless 131.0.0.0 (Windows 10): Executed 2 of 2 (1 FAILED) (0.3 secs / 0.1 secs)\n' +
      'TOTAL: 1 FAILED, 1 SUCCESS\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe('test-failure');
  });

  test('(R2.1b) marker word on a non-ERROR karma line (WARN) → test-failure', () => {
    const stdout =
      'WARN [launcher]: ChromeHeadless was not killed in 2000 ms, sending SIGKILL — it is not registered as running\n' +
      'TOTAL: 1 FAILED, 1 SUCCESS\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe('test-failure');
  });

  test('(R2.1b guard) genuine ERROR [launcher] line with a marker → still runner-unavailable', () => {
    // The regression guard: the anchoring must not blind the true case.
    // Timestamp-prefixed, exactly as karma emits it.
    const stdout =
      '21 05 2026 20:26:59.709:ERROR [launcher]: Cannot load browser "Bogus": it is not registered! Perhaps you are missing some plugin?\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('(R2.1b guard) ANSI-colored ERROR [config] line with a marker → still runner-unavailable', () => {
    // Colored karma output decorates its own lines; the anchor + marker
    // must match through the ANSI CSI sequences.
    const stdout =
      '\x1b[31m21 05 2026 20:27:30.634:ERROR [config]: \x1b[39mError in config file!\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe(
      'runner-unavailable',
    );
  });

  test('(R2.1b) marker and ERROR anchor on DIFFERENT lines → test-failure (same-line requirement)', () => {
    // An ERROR [launcher] line without a marker plus an assertion line
    // with a marker word must not combine into runner-unavailable.
    const stdout =
      'ERROR [launcher]: ChromeHeadless exited unexpectedly\n' +
      "\tassertion: expected 'no usable sandbox' warning to be suppressed\n" +
      'TOTAL: 1 FAILED\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe('test-failure');
  });
});

describe('classifyKarmaFailure — test-failure', () => {
  test('karma ran QUnit and a test failed → test-failure', () => {
    // A genuine test failure: the browser connected and executed tests.
    const stdout =
      'INFO [launcher]: Starting browser ChromeHeadless\n' +
      'INFO [Chrome Headless 131.0.0.0 (Windows 10)]: Connected on socket abc with id 1\n' +
      'Chrome Headless 131.0.0.0 (Windows 10): Executed 3 of 3 (1 FAILED) (0.4 secs / 0.2 secs)\n' +
      'TOTAL: 1 FAILED, 2 SUCCESS\n';
    expect(classifyKarmaFailure(karma({ exitCode: 1, stdout }))).toBe('test-failure');
  });

  test("the integration suite's fake karma failure stays a test-failure", () => {
    // The V1.3-4 quarantine integration tests use this exact stderr; the
    // classifier must NOT see it as a runner fault (built-in regression guard).
    expect(
      classifyKarmaFailure(
        karma({ exitCode: 1, stderr: 'karma: test failed — assertion mismatch' }),
      ),
    ).toBe('test-failure');
  });

  test('ambiguous non-zero exit with no marker → test-failure (bias rule)', () => {
    expect(
      classifyKarmaFailure(karma({ exitCode: 1, stdout: 'something went wrong', stderr: '' })),
    ).toBe('test-failure');
  });

  test('exitCode 0 (e.g. a result.failed timeout) → test-failure (bias rule)', () => {
    expect(classifyKarmaFailure(karma({ exitCode: 0, ok: false }))).toBe('test-failure');
  });
});

// =====================================================================
// V1.3.3-3 witnesses — Bug B (karma post-bootstrap module-load failure).
// The V1.3.3-3 identity stubs keep `classifyKarmaFailure` routing
// module-load shapes to `'test-failure'` (because `hasModuleLoadPattern`
// returns false and `extractFailedModule` returns null). These witnesses
// fail with specific assertion mismatches against the stub behaviour;
// V1.3.3-5 lands the real classifier branch + helpers and turns them
// green. All inputs are grounded in real karma + karma-ui5 output from
// the cap_try Reports-shape diagnosis (V1.3.3-DIAGNOSIS.md §Area 2).
// =====================================================================

// Real cap_try Reports-shape disconnect line.
const REPORTS_DISCONNECT_SINGLE =
  'WARN [Chrome Headless 131.0.0.0 (Windows 10)]: Disconnected, ' +
  'because no message in 30000 ms.\n';

// Two-line shape — karma frequently splits the disconnect across two
// lines. Historically (AM1) this matched the module-load pattern set;
// since R2.1(a) a disconnect ALONE is no longer module-load evidence in
// either shape.
const REPORTS_DISCONNECT_TWO_LINE =
  'WARN [Chrome Headless 131.0.0.0 (Windows 10)]: Disconnected (0 times)\n' +
  ', because no message in 30000 ms.\n';

const UI5_MODULESYSTEM_LOAD_FAIL =
  'failed to load JavaScript resource: sap/ui/export/Spreadsheet.js -  ' +
  'sap.ui.ModuleSystem\n';

const REPORTS_BOTH_SIGNALS =
  UI5_MODULESYSTEM_LOAD_FAIL + REPORTS_DISCONNECT_SINGLE;

describe('(AH6) classifyKarmaFailure — parametrised precedence table', () => {
  // bootstrap > module-load > test-failure. Five cells covering every
  // bootstrap × module-load × exitCode-<0 combination; pins the ordering
  // so accidental branch shuffling in V1.3.3-5 is caught immediately.
  type Cell = {
    readonly name: string;
    readonly result: KarmaResult;
    readonly expected: KarmaFailureClass;
  };

  const cells: readonly Cell[] = [
    {
      name: 'exitCode -1, no markers → runner-unavailable (spawn fault always wins)',
      result: karma({ exitCode: -1, stderr: 'spawn karma ENOENT' }),
      expected: 'runner-unavailable',
    },
    {
      name: 'exitCode 1, bootstrap PRESENT, module-load PRESENT → runner-unavailable (bootstrap wins)',
      result: karma({
        exitCode: 1,
        stdout:
          'ERROR [config]: Error in config file!\n' + UI5_MODULESYSTEM_LOAD_FAIL,
      }),
      expected: 'runner-unavailable',
    },
    {
      name: 'exitCode 1, bootstrap PRESENT, module-load absent → runner-unavailable',
      result: karma({ exitCode: 1, stdout: 'ERROR [config]: Error in config file!\n' }),
      expected: 'runner-unavailable',
    },
    {
      name: 'exitCode 1, bootstrap absent, module-load PRESENT → module-load-failure',
      result: karma({ exitCode: 1, stdout: REPORTS_BOTH_SIGNALS }),
      expected: 'module-load-failure',
    },
    {
      name: 'exitCode 1, bootstrap absent, module-load absent → test-failure (bias rule)',
      result: karma({ exitCode: 1, stdout: 'TOTAL: 1 FAILED\n' }),
      expected: 'test-failure',
    },
  ];

  test.each(cells)('$name', ({ result, expected }) => {
    expect(classifyKarmaFailure(result)).toBe(expected);
  });
});

describe('classifyKarmaFailure — module-load-failure cases (AM1, narrowed by R2.1a)', () => {
  // =====================================================================
  // R2.1(a) witnesses (AUDIT-v0.7.0 §5.3a) — `module-load-failure` now
  // requires POSITIVE evidence: the `sap.ui.ModuleSystem` load-fail line.
  // A no-message-disconnect ALONE is ambiguous (an LLM test that never
  // calls `done()` produces the identical line, and so does a transient
  // CDN/DNS blip — the live §3.1 quarantine) and now classifies
  // `test-failure` so the candidate keeps its refinement chance. These
  // witnesses fail on revert of the KARMA_MODULE_LOAD_PATTERNS narrowing.
  // =====================================================================

  test('(R2.1a) single-line no-message-disconnect ALONE → test-failure (refinement chance)', () => {
    expect(
      classifyKarmaFailure(
        karma({ exitCode: 1, stdout: REPORTS_DISCONNECT_SINGLE }),
      ),
    ).toBe('test-failure');
  });

  test('(R2.1a) TWO-LINE no-message-disconnect ALONE → test-failure', () => {
    expect(
      classifyKarmaFailure(
        karma({ exitCode: 1, stdout: REPORTS_DISCONNECT_TWO_LINE }),
      ),
    ).toBe('test-failure');
  });

  test('(R2.1a) disconnect with a different browserNoActivityTimeout (60000 ms) ALONE → test-failure', () => {
    expect(
      classifyKarmaFailure(
        karma({
          exitCode: 1,
          stdout: 'Disconnected, because no message in 60000 ms.\n',
        }),
      ),
    ).toBe('test-failure');
  });

  // =====================================================================
  // R2.1(a) REGRESSION GUARDS — the narrowing must not blind the genuine
  // module-load case: any transcript carrying the `sap.ui.ModuleSystem`
  // line still classifies `module-load-failure` and still short-circuits
  // to quarantine. Non-negotiable per the R2.1 done-when.
  // =====================================================================

  test('(R2.1a guard) UI5 ModuleSystem load-fail alone → still module-load-failure', () => {
    expect(
      classifyKarmaFailure(
        karma({ exitCode: 1, stdout: UI5_MODULESYSTEM_LOAD_FAIL }),
      ),
    ).toBe('module-load-failure');
  });

  test('(R2.1a guard) both signals together (the cap_try Reports shape) → still module-load-failure', () => {
    expect(
      classifyKarmaFailure(karma({ exitCode: 1, stdout: REPORTS_BOTH_SIGNALS })),
    ).toBe('module-load-failure');
  });

  test('negative pin: ordinary test failure with no module-load signal stays test-failure', () => {
    // Bias rule preserved — uncertain → test-failure.
    expect(
      classifyKarmaFailure(
        karma({
          exitCode: 1,
          stdout: '2 of 5 tests failed: AssertionError\n',
        }),
      ),
    ).toBe('test-failure');
  });
});

describe('(AC3) hasModuleLoadPattern — direct unit tests over combined output', () => {
  // AC3: pure-function signature over the pre-combined stdout+stderr
  // string. The call site (classifyKarmaFailure) does the join; the
  // helper has no reach-through to a `KarmaResult` (which doesn't expose
  // a `karmaResult` field anywhere on `VerifyResult` — that was the
  // V1.3.3-2 draft's implementation blocker).
  test('(R2.1a) returns false for single-line no-message-disconnect alone (not positive evidence)', () => {
    expect(hasModuleLoadPattern(REPORTS_DISCONNECT_SINGLE)).toBe(false);
  });

  test('(R2.1a) returns false for two-line no-message-disconnect alone', () => {
    expect(hasModuleLoadPattern(REPORTS_DISCONNECT_TWO_LINE)).toBe(false);
  });

  test('returns true for UI5 ModuleSystem load-fail', () => {
    expect(hasModuleLoadPattern(UI5_MODULESYSTEM_LOAD_FAIL)).toBe(true);
  });

  test('(R2.1a guard) returns true when the ModuleSystem line accompanies a disconnect', () => {
    expect(hasModuleLoadPattern(REPORTS_BOTH_SIGNALS)).toBe(true);
  });

  test('returns false for an empty combined output (no patterns)', () => {
    expect(hasModuleLoadPattern('')).toBe(false);
  });

  test('returns false for a plain test-failure line (bias rule)', () => {
    expect(hasModuleLoadPattern('2 of 5 tests failed: AssertionError\n')).toBe(
      false,
    );
  });
});

describe('(AC3 + AH3 + AH5) extractFailedModule — direct unit tests over combined output', () => {
  test('happy path: extracts the module ID without the `.js` extension', () => {
    expect(extractFailedModule(UI5_MODULESYSTEM_LOAD_FAIL)).toBe(
      'sap/ui/export/Spreadsheet',
    );
  });

  test('(AH3) ANSI-decorated input: regex must ANSI-strip before matching', () => {
    // The V1.3.3-2 draft's `(\S+?)` capture would have included the
    // ANSI escape codes in the returned module ID, breaking the
    // downstream `libNameFor` derivation. AH3 fixes the helper to
    // ANSI-strip its input as step 0.
    const ansiDecorated =
      '\x1b[31mfailed to load JavaScript resource: ' +
      'sap/ui/export/Spreadsheet.js -  sap.ui.ModuleSystem\x1b[0m\n';
    expect(extractFailedModule(ansiDecorated)).toBe(
      'sap/ui/export/Spreadsheet',
    );
  });

  test('line with leading/trailing whitespace → same module ID extracted', () => {
    const padded =
      '   failed to load JavaScript resource:   sap/ui/export/Spreadsheet.js  -  ' +
      'sap.ui.ModuleSystem   \n';
    expect(extractFailedModule(padded)).toBe('sap/ui/export/Spreadsheet');
  });

  test('(AH5) multiple failed-load lines → returns FIRST in document order', () => {
    // AH5: contract is "first in document order" (lowest character
    // index), the natural non-global `.match()` behaviour. Pinned
    // explicitly so the rule is not auditor-deferred.
    const multi =
      'failed to load JavaScript resource: sap/ui/export/Spreadsheet.js - sap.ui.ModuleSystem\n' +
      'failed to load JavaScript resource: sap/suite/ui/commons/Bar.js - sap.ui.ModuleSystem\n';
    expect(extractFailedModule(multi)).toBe('sap/ui/export/Spreadsheet');
  });

  test('no match → null', () => {
    expect(extractFailedModule('2 of 5 tests failed: AssertionError\n')).toBeNull();
  });
});

describe('(AH4) libNameFor — direct unit tests for namespace derivation', () => {
  test('2-segment module ID: sap/m/Button → sap.m', () => {
    expect(libNameFor('sap/m/Button')).toBe('sap.m');
  });

  test('3-segment module ID: sap/ui/export/Spreadsheet → sap.ui.export', () => {
    expect(libNameFor('sap/ui/export/Spreadsheet')).toBe('sap.ui.export');
  });

  test('(AH4) 4-segment cap fires: sap/ui/comp/smartfield/SmartField → sap.ui.comp (not sap.ui.comp.smartfield)', () => {
    // The naive split-drop-last would give `sap.ui.comp.smartfield`,
    // which is a sub-package, not a library. The 3-segment cap
    // conservatively under-shoots into a valid library namespace.
    expect(libNameFor('sap/ui/comp/smartfield/SmartField')).toBe('sap.ui.comp');
  });

  test('(R2.4) 4-segment library resolves via the table: sap/suite/ui/commons/HeaderContainer/Item → sap.suite.ui.commons', () => {
    // Behavior boundary (R2.4, AUDIT §5.5): pre-R2.4 this pinned the
    // documented-benign under-shoot to `sap.suite.ui` (a phantom — no such
    // library). `sap.suite.ui.commons` is now in KNOWN_SAP_UI5_LIBRARIES,
    // so the longest-prefix loop returns the REAL library before the
    // 3-segment cap fires. Reverting the table entry turns this red.
    expect(libNameFor('sap/suite/ui/commons/HeaderContainer/Item')).toBe(
      'sap.suite.ui.commons',
    );
  });

  test('(R2.4) deep two-segment libraries resolve via the table: sap.collaboration / sap.ovp / sap.apf', () => {
    // Same shape as the V1.5 A1 sap.viz fix — these are real two-segment
    // libraries whose modules live in deep paths; the 3-segment cap would
    // over-shoot each into a phantom namespace (`sap.collaboration.components`,
    // `sap.ovp.cards`, `sap.apf.api`) that --auto-apply-baseline-fixes could
    // write to manifest.json.
    expect(
      libNameFor('sap/collaboration/components/fiori/sharing/Component'),
    ).toBe('sap.collaboration');
    expect(libNameFor('sap/ovp/cards/charts/VizAnnotationManager')).toBe('sap.ovp');
    expect(libNameFor('sap/apf/api/Api')).toBe('sap.apf');
  });

  test('1-segment ID (theoretical): Foo → null (falls back to the without-module message)', () => {
    expect(libNameFor('Foo')).toBeNull();
  });

  test('(A1, V1.5) deep two-segment library: sap/viz/ui5/controls/VizFrame → sap.viz (not the phantom sap.viz.ui5)', () => {
    // The 3-segment cap would over-shoot into sap.viz.ui5 — a non-existent
    // library. The KNOWN_SAP_UI5_LIBRARIES longest-prefix match returns the
    // real library sap.viz, so --auto-apply-baseline-fixes never writes a
    // phantom that karma-ui5 would 404 on and hang.
    expect(libNameFor('sap/viz/ui5/controls/VizFrame')).toBe('sap.viz');
  });

  test('(A1, V1.5) deep two-segment library: sap/m/semantic/SemanticPage → sap.m', () => {
    expect(libNameFor('sap/m/semantic/SemanticPage')).toBe('sap.m');
  });
});
