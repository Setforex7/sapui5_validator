/**
 * SPEC §2.4 starter templates seeded when a project has no existing tests.
 *
 * For V1 the three documented choices (`sap.m`, `sap.f`, `fiori-elements`)
 * produce the same generic scaffold: a `testsuite.qunit.html`, the unit-test
 * entry pages, and an OPA5 entry stub. Differentiating the scaffold per
 * project type is deferred (SPEC §7) — the choice is recorded on the run
 * report so a V2 template differentiation lands without a schema change.
 *
 * The orchestrator decides whether scaffolding is appropriate (no
 * `webapp/test/` directory + interactive TTY). This module only writes
 * files; it does not probe the project or prompt the user.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertInsideProject } from '../../util/containment.js';

export type TemplateChoice = 'sap.m' | 'sap.f' | 'fiori-elements';

export const TEMPLATE_CHOICES: readonly TemplateChoice[] = Object.freeze([
  'sap.m',
  'sap.f',
  'fiori-elements',
]);

export interface TemplateScaffoldArgs {
  readonly projectRoot: string;
  readonly namespace: string;
  readonly choice: TemplateChoice;
}

export interface TemplateScaffoldResult {
  readonly files: readonly string[];
  readonly choice: TemplateChoice;
}

export async function scaffoldTestLayout(
  args: TemplateScaffoldArgs,
): Promise<TemplateScaffoldResult> {
  const root = args.projectRoot;
  const testDir = join(root, 'webapp', 'test');
  const unitDir = join(testDir, 'unit');
  const integrationDir = join(testDir, 'integration');
  // v0.8.1 V1: constant components, but `webapp/` (or `test/`) can be a link
  // out of the tree — assert before the mkdirs create anything.
  await assertInsideProject(unitDir, root);
  await assertInsideProject(integrationDir, root);
  await mkdir(unitDir, { recursive: true });
  await mkdir(integrationDir, { recursive: true });

  const written: string[] = [];
  await write(join(testDir, 'testsuite.qunit.html'), testsuiteHtml(args.namespace), root, written);
  await write(join(unitDir, 'unit.qunit.html'), unitHtml(args.namespace), root, written);
  await write(join(unitDir, 'unit.qunit.js'), unitJs(), root, written);
  await write(
    join(integrationDir, 'opaTests.qunit.html'),
    opaHtml(args.namespace),
    root,
    written,
  );
  await write(
    join(integrationDir, 'AllJourneys.js'),
    allJourneysJs(args.namespace),
    root,
    written,
  );
  return { files: written, choice: args.choice };
}

async function write(
  path: string,
  content: string,
  projectRoot: string,
  log: string[],
): Promise<void> {
  await assertInsideProject(path, projectRoot);
  await writeFile(path, content, 'utf8');
  log.push(path);
}

/**
 * The karma-ui5 html-mode discovery page. Tests are discovered through the
 * `sap.ui.require([...])` module-id array — the same shape `generate` parses
 * and writes via `src/generation/registration.ts`, so a freshly scaffolded
 * project is self-consistent with the registration logic. It is seeded with
 * the placeholder `unit.qunit.js` module; `generate` inserts one entry per
 * generated controller test.
 */
function testsuiteHtml(ns: string): string {
  const nsSlash = ns.replace(/\./gu, '/');
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `  <title>QUnit test suite for ${ns}</title>`,
    '  <meta charset="utf-8">',
    '  <script',
    '    id="sap-ui-bootstrap"',
    '    src="https://sdk.openui5.org/resources/sap-ui-core.js"',
    `    data-sap-ui-resourceroots='{ "${ns}": "../" }'`,
    '    data-sap-ui-async="true"></script>',
    '  <link rel="stylesheet" href="https://sdk.openui5.org/resources/sap/ui/thirdparty/qunit-2.css">',
    '  <script src="https://sdk.openui5.org/resources/sap/ui/thirdparty/qunit-2.js"></script>',
    '  <script>',
    '    QUnit.config.autostart = false;',
    '    sap.ui.require([',
    `      "${nsSlash}/test/unit/unit.qunit"`,
    '    ], function () {',
    '      QUnit.start();',
    '    });',
    '  </script>',
    '</head>',
    '<body>',
    '  <div id="qunit"></div>',
    '  <div id="qunit-fixture"></div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function unitHtml(ns: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `  <title>Unit tests for ${ns}</title>`,
    '  <meta charset="utf-8">',
    '  <script',
    '    id="sap-ui-bootstrap"',
    '    src="https://sdk.openui5.org/resources/sap-ui-core.js"',
    `    data-sap-ui-resourceroots='{"${ns}": "../../"}'`,
    '    data-sap-ui-async="true">',
    '  </script>',
    '  <link rel="stylesheet" href="https://sdk.openui5.org/resources/sap/ui/thirdparty/qunit-2.css">',
    '  <script src="https://sdk.openui5.org/resources/sap/ui/thirdparty/qunit-2.js"></script>',
    '  <script src="unit.qunit.js"></script>',
    '</head>',
    '<body>',
    '  <div id="qunit"></div>',
    '  <div id="qunit-fixture"></div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function unitJs(): string {
  return [
    '// Placeholder unit-test module. `sapui5-validate generate` writes one',
    '// QUnit file per controller and registers it in testsuite.qunit.html.',
    'sap.ui.define([], function () {',
    '  "use strict";',
    '  QUnit.module("placeholder");',
    '  QUnit.test("test infrastructure loads", function (assert) {',
    '    assert.ok(true, "unit suite bootstrap");',
    '  });',
    '});',
    '',
  ].join('\n');
}

function opaHtml(ns: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `  <title>OPA5 tests for ${ns}</title>`,
    '  <meta charset="utf-8">',
    '  <script',
    '    id="sap-ui-bootstrap"',
    '    src="https://sdk.openui5.org/resources/sap-ui-core.js"',
    `    data-sap-ui-resourceroots='{"${ns}": "../../"}'`,
    '    data-sap-ui-async="true">',
    '  </script>',
    '  <link rel="stylesheet" href="https://sdk.openui5.org/resources/sap/ui/thirdparty/qunit-2.css">',
    '  <script src="https://sdk.openui5.org/resources/sap/ui/thirdparty/qunit-2.js"></script>',
    '  <script src="AllJourneys.js"></script>',
    '</head>',
    '<body>',
    '  <div id="qunit"></div>',
    '  <div id="qunit-fixture"></div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function allJourneysJs(ns: string): string {
  return [
    'sap.ui.define([',
    '  "sap/ui/test/Opa5"',
    '], function (Opa5) {',
    '  "use strict";',
    '',
    '  Opa5.extendConfig({',
    '    arrangements: new Opa5(),',
    `    viewNamespace: "${ns}.view.",`,
    '    autoWait: true',
    '  });',
    '',
    '  // Per-view journey files added by `sapui5-validate generate` are required',
    '  // here in V2. For now this acts as a placeholder OPA5 suite entry.',
    '});',
    '',
  ].join('\n');
}
