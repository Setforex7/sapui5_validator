/**
 * V1.4-5 (AM6) â€” OPA5 parity test for the project-context block.
 *
 * Same contract as `qunit-prompt-context.test.ts`: omit-when-empty,
 * append-when-gap-touches-controller, and refinement-prompt parity
 * (V1.3.2-4 AH4 discipline).
 *
 * The OPA5 sinon-dialect parity (the `SAP_BUNDLED_SINON_CLAUSE`
 * analogue) stays deferred to V1.5+ per diagnosis Â§4.4. The
 * project-context block is graph-derived, NOT a sinon clause â€”
 * shipping it in both QUnit and OPA5 prompts is the V1.4-5 scope.
 */

import { describe, expect, test } from 'vitest';
import type { ProjectGraph } from '../../src/project/dependency-graph.js';
import {
  buildInitialOpa5Prompt,
  buildOpa5RefinementPrompt,
} from '../../src/generation/opa5.js';

const VIEW_REL = 'webapp/view/Main.view.xml';
const VIEW_CONTENT =
  '<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button text="X"/></mvc:View>';
const CONTROLLER_REL = 'webapp/controller/Main.controller.js';
const CONTROLLER_CONTENT =
  'sap.ui.define([], function () { return { onInit: function () {} }; });';
const JOURNEY_REL = 'webapp/test/integration/MainJourney.qunit.js';

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
    karmaClientLibs: ['sap.m', 'sap.ui.core'],
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

describe('buildInitialOpa5Prompt â€” V1.4-5 project-context block', () => {
  test('without projectGraph: no context block', () => {
    const prompt = buildInitialOpa5Prompt({
      namespace: 'demo.app',
      viewRel: VIEW_REL,
      viewName: 'Main',
      viewContent: VIEW_CONTENT,
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      journeyRel: JOURNEY_REL,
    });
    expect(prompt).not.toContain('Project library context');
    // Original OPA5 framing intact.
    expect(prompt).toContain('Task: generate an OPA5 journey');
    expect(prompt).toContain('Return ONLY a single JSON object of the shape:');
  });

  test('with empty graph: no context block', () => {
    const prompt = buildInitialOpa5Prompt({
      namespace: 'demo.app',
      viewRel: VIEW_REL,
      viewName: 'Main',
      viewContent: VIEW_CONTENT,
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      journeyRel: JOURNEY_REL,
      projectGraph: makeEmptyGraph(),
    });
    expect(prompt).not.toContain('Project library context');
  });

  test('with gap touching this controller: appends context block', () => {
    const prompt = buildInitialOpa5Prompt({
      namespace: 'demo.app',
      viewRel: VIEW_REL,
      viewName: 'Main',
      viewContent: VIEW_CONTENT,
      controllerRel: CONTROLLER_REL,
      controllerContent: CONTROLLER_CONTENT,
      journeyRel: JOURNEY_REL,
      projectGraph: makeGraphWithGap(),
    });
    expect(prompt).toContain('Project library context (karma-ui5 preload set):');
    // karma.conf.js override is enumerated (not "(none)" this time).
    expect(prompt).toContain('karma.conf.js client.libs override: sap.m, sap.ui.core');
    expect(prompt).toContain('Pre-registered stub strategy:');
    expect(prompt).toContain('sap.ui.define("sap/ui/export/Spreadsheet"');
    // OPA5-specific guidance is preserved.
    expect(prompt).toContain('iTeardownMyApp');
  });
});

describe('buildOpa5RefinementPrompt â€” V1.4-5 project-context block (AP4)', () => {
  test('without controllerRel or projectGraph: no context block', () => {
    const prompt = buildOpa5RefinementPrompt({
      viewName: 'Main',
      journeyRel: JOURNEY_REL,
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'err',
    });
    expect(prompt).not.toContain('Project library context');
  });

  test('with gap touching the paired controller: appends the block', () => {
    const prompt = buildOpa5RefinementPrompt({
      viewName: 'Main',
      journeyRel: JOURNEY_REL,
      controllerRel: CONTROLLER_REL,
      previousContent: 'sap.ui.define([], function(){});',
      verifyFeedback: 'err',
      projectGraph: makeGraphWithGap(),
    });
    expect(prompt).toContain('Project library context (karma-ui5 preload set):');
    expect(prompt).toContain('Pre-registered stub strategy:');
    // Refinement framing intact.
    expect(prompt).toContain('Your previous OPA5 journey did not pass verification.');
    expect(prompt).toContain('Return ONLY a single JSON object of the shape:');
  });
});
