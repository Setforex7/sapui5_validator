/**
 * V1.4-5 (AH3) â€” pins the project-context block contract for the
 * QUnit generation prompts:
 *
 *   1. **Gap-empty omits the block** â€” `buildInitialQunitPrompt`
 *      produces a prompt **byte-for-byte identical** to the committed
 *      golden no-gap prompt
 *      (`test/fixtures/prompts/qunit-initial-v1.3.3-baseline.txt`,
 *      kept under its historical name; the golden content now also
 *      carries the V1.6 controller-module-id pin â€” see the dedicated
 *      describe below) when no `projectGraph` is supplied OR the
 *      controller has no lib in the graph's `unpreloadedLibs`. This is
 *      the load-bearing invariant â€” every prompt without an
 *      unpreloaded-lib gap must stay the size + shape the rest of the
 *      test suite assumes (argv ceiling, audit dumps,
 *      refinement-truncation accounting).
 *
 *   2. **Gap-non-empty appends the block** with the pre-registered-
 *      stub strategy paragraph (AC4), naming the unpreloaded libs
 *      and the offending controller module IDs.
 *
 *   3. **Refinement prompt has parity** â€” V1.3.2-4 AH4 discipline:
 *      clauses thread to both initial AND refinement prompts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ProjectGraph } from '../../src/project/dependency-graph.js';
import {
  buildInitialQunitPrompt,
  buildQunitRefinementPrompt,
} from '../../src/generation/qunit.js';
import { computeModuleId } from '../../src/generation/registration.js';
import {
  SAP_BUNDLED_SINON_CLAUSE,
  SAP_BUNDLED_SINON_CLAUSE_TS,
} from '../../src/project/sinon-dialect.js';

const BASELINE_FIXTURE = join(
  __dirname,
  '..',
  'fixtures',
  'prompts',
  'qunit-initial-v1.3.3-baseline.txt',
);

const CONTROLLER_REL = 'webapp/controller/Main.controller.js';
const CONTROLLER_CONTENT =
  'sap.ui.define([], function () { return { onInit: function () {} }; });';
const TEST_REL = 'webapp/test/unit/controller/Main.controller.qunit.js';

function makeGraphWithGap(): ProjectGraph {
  return {
    controllers: [
      {
        controllerRel: CONTROLLER_REL,
        imports: [
          'sap/ui/core/mvc/Controller',
          'sap/ui/export/Spreadsheet',
        ],
        libNamespaces: ['sap.ui.core', 'sap.ui.export'],
      },
    ],
    manifestLibs: ['sap.m', 'sap.ui.core'],
    karmaClientLibs: [],
    alwaysAvailableLibs: ['sap.ui.core', 'sap.ui.thirdparty'],
    unpreloadedLibs: [
      {
        lib: 'sap.ui.export',
        importedBy: [CONTROLLER_REL],
        suggestedFix: 'manifest',
        cdnServed: true,
        cdnProbed: true,
      },
    ],
    projectNamespace: 'demo.app',
  };
}

function makeEmptyGraph(): ProjectGraph {
  return {
    controllers: [
      {
        controllerRel: CONTROLLER_REL,
        imports: ['sap/ui/core/mvc/Controller'],
        libNamespaces: ['sap.ui.core'],
      },
    ],
    manifestLibs: ['sap.m', 'sap.ui.core'],
    karmaClientLibs: [],
    alwaysAvailableLibs: ['sap.ui.core', 'sap.ui.thirdparty'],
    unpreloadedLibs: [],
    projectNamespace: 'demo.app',
  };
}

describe('buildInitialQunitPrompt â€” V1.4-5 project-context block', () => {
  test('without projectGraph: byte-for-byte parity with v1.3.3 baseline fixture', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'unknown',
    });
    const baseline = readFileSync(BASELINE_FIXTURE, 'utf8');
    expect(prompt).toBe(baseline);
  });

  test('with empty projectGraph (no gap): byte-for-byte parity with baseline', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'unknown',
      projectGraph: makeEmptyGraph(),
    });
    const baseline = readFileSync(BASELINE_FIXTURE, 'utf8');
    expect(prompt).toBe(baseline);
  });

  test('with controller whose libs do NOT intersect the gap: byte-for-byte parity', () => {
    // The graph has an unpreloaded lib, but for a different controller.
    const graph: ProjectGraph = {
      ...makeGraphWithGap(),
      controllers: [
        {
          controllerRel: 'webapp/controller/Other.controller.js',
          imports: ['sap/ui/export/Spreadsheet'],
          libNamespaces: ['sap.ui.export'],
        },
      ],
    };
    const prompt = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL, // not in graph.controllers
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'unknown',
      projectGraph: graph,
    });
    const baseline = readFileSync(BASELINE_FIXTURE, 'utf8');
    expect(prompt).toBe(baseline);
  });

  test('with gap touching this controller: appends the context block', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'unknown',
      projectGraph: makeGraphWithGap(),
    });
    // The header line that opens the context block.
    expect(prompt).toContain('Project library context (karma-ui5 preload set):');
    // Manifest lib enumeration.
    expect(prompt).toContain('Declared in manifest.json: sap.m, sap.ui.core');
    // No client.libs override â†’ "(none)".
    expect(prompt).toContain('karma.conf.js client.libs override: (none)');
    // Names the unpreloaded lib + the offending module ID that pulled it in.
    expect(prompt).toContain('* sap.ui.export (via "sap/ui/export/Spreadsheet"');
    // The pre-registered-stub strategy paragraph (AC4 â€” fixed wording).
    expect(prompt).toContain('Pre-registered stub strategy:');
    expect(prompt).toContain('sap.ui.define("sap/ui/export/Spreadsheet", [], function () {');
    expect(prompt).toContain('return function StubModule() {};');
    // The instance-level sinon-stub fallback advice â€” pattern-agnostic so
    // it transfers cleanly to OPA5 (AM6).
    expect(prompt).toContain('sinon.stub');
  });

  test('with gap: original requirements + schema instruction still present', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'unknown',
      projectGraph: makeGraphWithGap(),
    });
    // The requirement list is preserved end-to-end.
    expect(prompt).toContain('Use `sap.ui.define([...], function (...) { ... })`.');
    // The schema instruction still anchors the tail.
    expect(prompt).toContain('Return ONLY a single JSON object of the shape:');
    expect(prompt).toContain('No prose, no markdown fences.');
  });
});

describe('buildQunitRefinementPrompt â€” V1.4-5 project-context block (AP4)', () => {
  test('without projectGraph: no context block', () => {
    const prompt = buildQunitRefinementPrompt({
      controllerRel: CONTROLLER_REL,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'error',
      sinonDialect: 'unknown',
    });
    expect(prompt).not.toContain('Project library context');
  });

  test('with gap touching this controller: appends the same context block', () => {
    const prompt = buildQunitRefinementPrompt({
      controllerRel: CONTROLLER_REL,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'error',
      sinonDialect: 'unknown',
      projectGraph: makeGraphWithGap(),
    });
    // Parity with the initial prompt's context block.
    expect(prompt).toContain('Project library context (karma-ui5 preload set):');
    expect(prompt).toContain('Pre-registered stub strategy:');
    // The original refinement framing is preserved.
    expect(prompt).toContain('Your previous QUnit test did not pass verification.');
    expect(prompt).toContain('Verification output (raw):');
    expect(prompt).toContain('Return ONLY a single JSON object of the shape:');
  });

  test('with empty graph: no context block', () => {
    const prompt = buildQunitRefinementPrompt({
      controllerRel: CONTROLLER_REL,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'error',
      sinonDialect: 'unknown',
      projectGraph: makeEmptyGraph(),
    });
    expect(prompt).not.toContain('Project library context');
  });
});

describe('buildInitialQunitPrompt â€” V1.6 controller module-id pin', () => {
  // Regression for the cap_try App/Shop quarantines: the LLM was importing the
  // controller under test by a derived id that dropped the `.controller`
  // segment of a `*.controller.js` file (e.g. `cap_try/controller/App`, which
  // UI5 resolves to a non-existent `controller/App.js` â†’ 404 â†’ karma
  // browserNoActivityTimeout â†’ a spurious module-load quarantine). The prompt
  // now pins the exact id; these pin its presence and correctness.
  const CONTENT = 'sap.ui.define([], function () { return {}; });';

  test('a *.controller.js file pins the import id WITH its .controller segment', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/App.controller.js',
      controllerContent: CONTENT,
      expectedTestRel: 'webapp/test/unit/controller/App.controller.qunit.js',
      namespace: 'cap_try',
      sinonDialect: 'sap-bundled',
    });
    expect(prompt).toContain(
      'Controller module id (import the controller under test with EXACTLY this id, unchanged): cap_try/controller/App.controller',
    );
    expect(prompt).toContain(
      'Import the controller under test by the exact "Controller module id" shown',
    );
  });

  test('a plain .js module pins the bare id (no spurious .controller appended)', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/BaseController.js',
      controllerContent: CONTENT,
      expectedTestRel: 'webapp/test/unit/controller/BaseController.qunit.js',
      namespace: 'cap_try',
      sinonDialect: 'unknown',
    });
    expect(prompt).toContain(
      'Controller module id (import the controller under test with EXACTLY this id, unchanged): cap_try/controller/BaseController',
    );
    // Guard against over-correction: a plain `.js` file must not gain `.controller`.
    expect(prompt).not.toContain('BaseController.controller');
  });

  test('the pinned id is exactly computeModuleId(controllerRel) â€” one source of truth', () => {
    const controllerRel = 'webapp/controller/Sub/Detail.controller.js';
    const prompt = buildInitialQunitPrompt({
      controllerRel,
      controllerContent: CONTENT,
      expectedTestRel: 'webapp/test/unit/controller/Sub/Detail.controller.qunit.js',
      namespace: 'my.app',
      sinonDialect: 'unknown',
    });
    const expected = computeModuleId({ namespace: 'my.app', fileRel: controllerRel });
    expect(expected).toBe('my/app/controller/Sub/Detail.controller');
    expect(prompt).toContain(expected);
  });
});

describe('R1.7a (AUDIT Â§5.7a) â€” the module-id pin threads to BOTH prompts', () => {
  // The regression class 0.7.0 fixed once: the pin existed only in the
  // initial prompt, so refinement attempts 2/3 could re-drop the
  // `.controller` segment and recreate the wrong-import bug as a spurious
  // module-load quarantine. AH4 discipline: clauses thread to both prompts.
  const PIN_LINE =
    'Controller module id (import the controller under test with EXACTLY this id, unchanged): cap_try/controller/App.controller';

  test('initial and refinement prompts carry the identical pin line', () => {
    const initial = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/App.controller.js',
      controllerContent: 'sap.ui.define([], function () { return {}; });',
      expectedTestRel: 'webapp/test/unit/controller/App.controller.qunit.js',
      namespace: 'cap_try',
      sinonDialect: 'sap-bundled',
    });
    const refinement = buildQunitRefinementPrompt({
      controllerRel: 'webapp/controller/App.controller.js',
      expectedTestRel: 'webapp/test/unit/controller/App.controller.qunit.js',
      namespace: 'cap_try',
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'karma: module load failed',
      sinonDialect: 'sap-bundled',
    });
    expect(initial).toContain(PIN_LINE);
    expect(refinement).toContain(PIN_LINE);
  });

  test('the refinement pin uses computeModuleId â€” .controller preserved, none invented', () => {
    const refinement = buildQunitRefinementPrompt({
      controllerRel: 'webapp/controller/BaseController.js',
      expectedTestRel: 'webapp/test/unit/controller/BaseController.qunit.js',
      namespace: 'cap_try',
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'error',
      sinonDialect: 'unknown',
    });
    expect(refinement).toContain(
      'Controller module id (import the controller under test with EXACTLY this id, unchanged): cap_try/controller/BaseController',
    );
    expect(refinement).not.toContain('BaseController.controller');
  });
});

describe('V1.9.2 (TG-PROMPT) â€” the TypeScript QUnit prompt contract', () => {
  const TS_CONTROLLER_REL = 'webapp/controller/App.controller.ts';
  const TS_CONTROLLER_CONTENT =
    'import Controller from "sap/ui/core/mvc/Controller";\n' +
    'export default class App extends Controller { public onInit(): void {} }';
  const TS_TEST_REL = 'webapp/test/unit/controller/App.controller.qunit.ts';
  // The ES default-import specifier the prompt must pin === computeModuleId with
  // the `.ts` stripped (TG-MODULEID). Matches the repo TS fixture's real import.
  const TS_IMPORT_ID = computeModuleId({
    namespace: 'e2e.real.ts',
    fileRel: TS_CONTROLLER_REL,
  });

  test('TS_IMPORT_ID is the .ts-stripped ES specifier (sanity for the pin below)', () => {
    expect(TS_IMPORT_ID).toBe('e2e/real/ts/controller/App.controller');
  });

  test('initial: typescript-fenced, ESM steer, .qunit.ts, ES import specifier â€” never the AMD JS shape', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: TS_CONTROLLER_REL,
      controllerContent: TS_CONTROLLER_CONTENT,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      sinonDialect: 'unknown',
      projectLanguage: 'ts',
    });
    // TS fence over the controller source; never the JS fence (the load-bearing
    // discriminator â€” reverting the TS branch re-emits ```javascript here).
    expect(prompt).toContain('```typescript');
    expect(prompt).not.toContain('```javascript');
    // ES-module steer, and NO AMD array-dependency form (a real AMD test's shape).
    expect(prompt).toContain('native ES');
    expect(prompt).toContain('import <ControllerClass> from');
    expect(prompt).not.toContain('sap.ui.define([');
    // Requests a `.qunit.ts` artifact, not `.qunit.js`.
    expect(prompt).toContain('<complete contents of the .qunit.ts file>');
    expect(prompt).not.toContain('<complete contents of the .qunit.js file>');
    // Pins the controller import as its ES specifier (== computeModuleId, .ts off).
    expect(prompt).toContain(
      `Controller module id (import the controller under test with EXACTLY this id, unchanged): ${TS_IMPORT_ID}`,
    );
  });

  test('refinement: typescript-fenced + .qunit.ts schema, ESM-kept, never the AMD JS shape', () => {
    const prompt = buildQunitRefinementPrompt({
      controllerRel: TS_CONTROLLER_REL,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      previousContent: `import App from "${TS_IMPORT_ID}";`,
      verifyFeedback: 'tsc --noEmit: error',
      sinonDialect: 'unknown',
      projectLanguage: 'ts',
    });
    expect(prompt).toContain('```typescript');
    expect(prompt).not.toContain('```javascript');
    expect(prompt).toContain('<corrected complete .qunit.ts file content>');
    expect(prompt).not.toContain('<corrected complete .qunit.js file content>');
    expect(prompt).not.toContain('sap.ui.define([');
    // The pin threads to the refinement prompt too (AH4 discipline).
    expect(prompt).toContain(
      `Controller module id (import the controller under test with EXACTLY this id, unchanged): ${TS_IMPORT_ID}`,
    );
  });

  test('TG-STUB-CONSIST: the AMD unpreloaded-stub block never fires for TS, even with a gap graph', () => {
    // A graph WITH a gap touching this very controller. On the JS path this
    // appends the `sap.ui.define`-shaped pre-registered-stub block; the TS path
    // must never splice it (the block is AMD, wrong for an ES-module project).
    const graphWithGap: ProjectGraph = {
      controllers: [
        {
          controllerRel: TS_CONTROLLER_REL,
          imports: ['sap/ui/core/mvc/Controller', 'sap/ui/export/Spreadsheet'],
          libNamespaces: ['sap.ui.core', 'sap.ui.export'],
        },
      ],
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [],
      alwaysAvailableLibs: ['sap.ui.core', 'sap.ui.thirdparty'],
      unpreloadedLibs: [
        {
          lib: 'sap.ui.export',
          importedBy: [TS_CONTROLLER_REL],
          suggestedFix: 'manifest',
          cdnServed: true,
          cdnProbed: true,
        },
      ],
      projectNamespace: 'e2e.real.ts',
    };
    const prompt = buildInitialQunitPrompt({
      controllerRel: TS_CONTROLLER_REL,
      controllerContent: TS_CONTROLLER_CONTENT,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      sinonDialect: 'unknown',
      projectLanguage: 'ts',
      projectGraph: graphWithGap,
    });
    expect(prompt).not.toContain('Project library context');
    expect(prompt).not.toContain('Pre-registered stub strategy:');
    // The stub block registers an AMD module as `sap.ui.define("<id>", [], …)`;
    // that exact form must be absent (the TS prompt's anti-AMD instruction text
    // mentions `sap.ui.define(...)`, so guard the quoted-id registration form).
    expect(prompt).not.toContain('sap.ui.define("');

    // Witness the contrast: the SAME gap graph on the JS path DOES append the
    // block â€” so the omission above is the TS gate, not an empty graph.
    const jsPrompt = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/App.controller.js',
      controllerContent: 'sap.ui.define([], function () { return {}; });',
      expectedTestRel: 'webapp/test/unit/controller/App.controller.qunit.js',
      namespace: 'e2e.real.ts',
      sinonDialect: 'unknown',
      projectGraph: {
        ...graphWithGap,
        controllers: [
          {
            controllerRel: 'webapp/controller/App.controller.js',
            imports: ['sap/ui/core/mvc/Controller', 'sap/ui/export/Spreadsheet'],
            libNamespaces: ['sap.ui.core', 'sap.ui.export'],
          },
        ],
        unpreloadedLibs: [
          {
            lib: 'sap.ui.export',
            importedBy: ['webapp/controller/App.controller.js'],
            suggestedFix: 'manifest',
            cdnServed: true,
            cdnProbed: true,
          },
        ],
      },
    });
    expect(jsPrompt).toContain('Project library context');
    expect(jsPrompt).toContain('Pre-registered stub strategy:');
  });

  test('frozen JS witness: an explicit projectLanguage:"js" prompt is byte-identical to the baseline', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'unknown',
      projectLanguage: 'js',
    });
    const baseline = readFileSync(BASELINE_FIXTURE, 'utf8');
    expect(prompt).toBe(baseline);
  });
});

describe('V1.9.3 (D4 / G3) — TypeScript prompts get the ES-module sinon clause, not the AMD one', () => {
  // The shipped 1.1.0 TS path appended `SAP_BUNDLED_SINON_CLAUSE` (which mandates
  // *"Depend on `sap/ui/thirdparty/sinon` in the `sap.ui.define` array"*) inside a
  // prompt that forbids `sap.ui.define` — a self-contradiction (D4). The fix
  // swaps the TWO TS builders to `SAP_BUNDLED_SINON_CLAUSE_TS` (ES `import` form);
  // the JS builders keep `SAP_BUNDLED_SINON_CLAUSE` byte-for-byte.
  //
  // NOTE on the "no AMD" assertion: the TS prompt's own anti-AMD instruction
  // legitimately *names* `sap.ui.define` to forbid it, so a blanket
  // `.not.toContain('sap.ui.define')` is unsatisfiable (and not what D4 is about).
  // D4 is specifically that the spliced *sinon clause* must not MANDATE the AMD
  // array form — so we guard the distinctive AMD-mandating phrase
  // ("sap.ui.define array") and the full JS clause string, mirroring the existing
  // `not.toContain('sap.ui.define("')` convention used for the stub block above.
  const TS_CONTROLLER_REL = 'webapp/controller/App.controller.ts';
  const TS_CONTROLLER_CONTENT =
    'import Controller from "sap/ui/core/mvc/Controller";\n' +
    'export default class App extends Controller { public onInit(): void {} }';
  const TS_TEST_REL = 'webapp/test/unit/controller/App.controller.qunit.ts';

  test('initial TS + sap-bundled: ES-module sinon clause spliced, AMD clause absent', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: TS_CONTROLLER_REL,
      controllerContent: TS_CONTROLLER_CONTENT,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      sinonDialect: 'sap-bundled',
      projectLanguage: 'ts',
    });
    // The TS sinon clause is present (RED before the wiring fix — the builder
    // still splices the JS clause).
    expect(prompt).toContain(SAP_BUNDLED_SINON_CLAUSE_TS);
    // The full AMD JS clause is NOT spliced, and its AMD-mandating phrase is gone.
    expect(prompt).not.toContain(SAP_BUNDLED_SINON_CLAUSE);
    expect(prompt).not.toContain('sap.ui.define array');
    // The 1.17 guidance survives in the TS clause.
    expect(prompt).toContain('sinon 1.17');
    expect(prompt).toContain('import sinon from "sap/ui/thirdparty/sinon"');
  });

  test('refinement TS + sap-bundled: ES-module sinon clause spliced, AMD clause absent', () => {
    const prompt = buildQunitRefinementPrompt({
      controllerRel: TS_CONTROLLER_REL,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      previousContent: 'import App from "e2e/real/ts/controller/App.controller";',
      verifyFeedback: 'tsc --noEmit: error',
      sinonDialect: 'sap-bundled',
      projectLanguage: 'ts',
    });
    expect(prompt).toContain(SAP_BUNDLED_SINON_CLAUSE_TS);
    expect(prompt).not.toContain(SAP_BUNDLED_SINON_CLAUSE);
    expect(prompt).not.toContain('sap.ui.define array');
    expect(prompt).toContain('sinon 1.17');
    expect(prompt).toContain('import sinon from "sap/ui/thirdparty/sinon"');
  });

  test('JS-unchanged witness: a JS + sap-bundled prompt still splices the AMD clause byte-for-byte', () => {
    // Freeze guard — the JS builders must keep SAP_BUNDLED_SINON_CLAUSE; if a
    // future change swaps the JS path to the TS clause, this goes RED.
    const initial = buildInitialQunitPrompt({
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      sinonDialect: 'sap-bundled',
    });
    expect(initial).toContain(SAP_BUNDLED_SINON_CLAUSE);
    expect(initial).not.toContain(SAP_BUNDLED_SINON_CLAUSE_TS);

    const refinement = buildQunitRefinementPrompt({
      controllerRel: CONTROLLER_REL,
      expectedTestRel: TEST_REL,
      namespace: 'demo.app',
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'error',
      sinonDialect: 'sap-bundled',
    });
    expect(refinement).toContain(SAP_BUNDLED_SINON_CLAUSE);
    expect(refinement).not.toContain(SAP_BUNDLED_SINON_CLAUSE_TS);
  });
});

describe('V1.9.9 — TS prompts forbid importing QUnit (double-define contract)', () => {
  // The shipped 1.5.0 TS initial prompt LICENSED the import ("If you reference
  // the `QUnit` global through an import, import it from
  // `"sap/ui/thirdparty/qunit-2"`"). `@sapui5/types` declares that module, so
  // the import is tsc-green — but the project's ESM→AMD transpile turns it into
  // a second load of qunit-2.js next to the testsuite HTML's <script> tag,
  // double-defining QUnit and killing the whole suite at runtime (8/14
  // generated cap_try_ts tests carried it). The fix flips the bullet to a
  // prohibition and threads it to BOTH TS prompts (AH4).
  //
  // NOTE on the assertions: the prohibition legitimately *names*
  // `sap/ui/thirdparty/qunit-2` to forbid it, so a blanket
  // `.not.toContain('sap/ui/thirdparty/qunit-2')` is unsatisfiable (same
  // convention as the D4 note above for `sap.ui.define`). What must be gone is
  // the *licensing phrase*; what must be present is the prohibition.
  const TS_CONTROLLER_REL = 'webapp/controller/App.controller.ts';
  const TS_CONTROLLER_CONTENT =
    'import Controller from "sap/ui/core/mvc/Controller";\n' +
    'export default class App extends Controller { public onInit(): void {} }';
  const TS_TEST_REL = 'webapp/test/unit/controller/App.controller.qunit.ts';

  test('initial TS: the licensing bullet is gone, the prohibition is present', () => {
    const prompt = buildInitialQunitPrompt({
      controllerRel: TS_CONTROLLER_REL,
      controllerContent: TS_CONTROLLER_CONTENT,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      sinonDialect: 'unknown',
      projectLanguage: 'ts',
    });
    // RED before the fix — the exact licensing phrase the 1.5.0 prompt carried.
    expect(prompt).not.toContain(
      'If you reference the `QUnit` global through an import',
    );
    expect(prompt).not.toContain('import it from');
    expect(prompt).toContain('Do NOT import QUnit');
    expect(prompt).toContain('pre-loaded browser global');
  });

  test('refinement TS: the prohibition threads to attempts 2/3 (AH4)', () => {
    const prompt = buildQunitRefinementPrompt({
      controllerRel: TS_CONTROLLER_REL,
      expectedTestRel: TS_TEST_REL,
      namespace: 'e2e.real.ts',
      previousContent:
        'import QUnit from "sap/ui/thirdparty/qunit-2";\n' +
        'import App from "e2e/real/ts/controller/App.controller";',
      verifyFeedback: 'shape: forbidden qunit-2 import',
      sinonDialect: 'unknown',
      projectLanguage: 'ts',
    });
    expect(prompt).toContain('Do NOT import QUnit');
    expect(prompt).toContain('pre-loaded browser global');
  });

  test('anti-overgeneralization witness: sap-bundled TS prompts still mandate the sinon import', () => {
    // The prohibition applies to QUnit ONLY. If its wording ever makes the
    // builders (or a future edit) drop the legitimate ES sinon import
    // instruction, this goes RED.
    for (const prompt of [
      buildInitialQunitPrompt({
        controllerRel: TS_CONTROLLER_REL,
        controllerContent: TS_CONTROLLER_CONTENT,
        expectedTestRel: TS_TEST_REL,
        namespace: 'e2e.real.ts',
        sinonDialect: 'sap-bundled',
        projectLanguage: 'ts',
      }),
      buildQunitRefinementPrompt({
        controllerRel: TS_CONTROLLER_REL,
        expectedTestRel: TS_TEST_REL,
        namespace: 'e2e.real.ts',
        previousContent: 'import App from "e2e/real/ts/controller/App.controller";',
        verifyFeedback: 'tsc --noEmit: error',
        sinonDialect: 'sap-bundled',
        projectLanguage: 'ts',
      }),
    ]) {
      expect(prompt).toContain('Do NOT import QUnit');
      expect(prompt).toContain('import sinon from "sap/ui/thirdparty/sinon"');
    }
  });
});
