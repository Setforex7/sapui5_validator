/**
 * Snapshot the seven check prompts. SPEC §2.8 / CLAUDE.md Session-7 guidance:
 * any silent change to a prompt should require updating the snapshot, forcing
 * a conscious decision. If you intentionally tweak a prompt, re-run with
 * `--update`. If you didn't, the diff is the bug.
 */

import { describe, expect, test } from 'vitest';
import { buildNoDirectDomPrompt } from '../../src/checks/no-direct-dom.js';
import { buildNoSyncOdataPrompt } from '../../src/checks/no-sync-odata.js';
import { buildMissingTeardownPrompt } from '../../src/checks/missing-teardown.js';
import { buildMissingI18nPrompt } from '../../src/checks/missing-i18n.js';
import { buildManifestDriftPrompt } from '../../src/checks/manifest-component-drift.js';
import { buildGlobalsInViewsPrompt } from '../../src/checks/globals-in-views.js';
import { buildMissingCoveragePrompt } from '../../src/checks/missing-test-coverage.js';

const RELPATH = 'webapp/controller/Main.controller.js';
const SAMPLE_JS = 'sap.ui.define([], function () { return { onInit: function () {} }; });';
const SAMPLE_XML = '<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button text="Submit"/></mvc:View>';
const MANIFEST = '{"sap.app":{"type":"application"}}';

describe('check prompt snapshots', () => {
  test('no-direct-dom', () => {
    expect(buildNoDirectDomPrompt({ relPath: RELPATH, content: SAMPLE_JS })).toMatchSnapshot();
  });
  test('no-sync-odata', () => {
    expect(buildNoSyncOdataPrompt({ relPath: RELPATH, content: SAMPLE_JS })).toMatchSnapshot();
  });
  test('missing-teardown', () => {
    expect(
      buildMissingTeardownPrompt({
        relPath: 'webapp/test/unit/Main.qunit.js',
        content: 'QUnit.module("M");',
      }),
    ).toMatchSnapshot();
  });
  test('missing-i18n', () => {
    expect(
      buildMissingI18nPrompt({
        relPath: 'webapp/view/Main.view.xml',
        content: SAMPLE_XML,
      }),
    ).toMatchSnapshot();
  });
  test('manifest-component-drift', () => {
    expect(buildManifestDriftPrompt({ manifest: MANIFEST, component: SAMPLE_JS })).toMatchSnapshot();
  });
  test('globals-in-views — with paired controller', () => {
    expect(
      buildGlobalsInViewsPrompt({
        viewRelPath: 'webapp/view/Main.view.xml',
        viewContent: SAMPLE_XML,
        controllerRelPath: RELPATH,
        controllerContent: SAMPLE_JS,
      }),
    ).toMatchSnapshot();
  });
  test('globals-in-views — without paired controller', () => {
    expect(
      buildGlobalsInViewsPrompt({
        viewRelPath: 'webapp/view/Orphan.view.xml',
        viewContent: SAMPLE_XML,
        controllerRelPath: null,
        controllerContent: null,
      }),
    ).toMatchSnapshot();
  });
  test('missing-test-coverage — test file present', () => {
    expect(
      buildMissingCoveragePrompt({
        controllerRelPath: RELPATH,
        controllerContent: SAMPLE_JS,
        testRelPath: 'webapp/test/unit/controller/Main.controller.qunit.js',
        testContent: 'QUnit.test("onInit", function (a) { a.ok(true); });',
      }),
    ).toMatchSnapshot();
  });
  test('missing-test-coverage — test file absent', () => {
    expect(
      buildMissingCoveragePrompt({
        controllerRelPath: RELPATH,
        controllerContent: SAMPLE_JS,
        testRelPath: 'webapp/test/unit/controller/Main.controller.qunit.js',
        testContent: null,
      }),
    ).toMatchSnapshot();
  });
});
