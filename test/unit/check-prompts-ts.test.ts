/**
 * V1.9 GA1-10 — TS-aware check prompt framing (golden-prompt witness).
 *
 * Each source-fenced check prompt, on a TypeScript project, must:
 *   - fence the source as ` ```typescript ` (NOT ` ```javascript `), and
 *   - carry the ES-module/class guidance that forbids rewriting the file into
 *     `sap.ui.define([...])` (the AMD form is build output; emitting it would
 *     corrupt an ES-module `.ts`).
 * And the JS framing must stay BYTE-IDENTICAL: `language: 'js'` (and the
 * default, no `language`) produce the exact pre-V1.9 prompt. If the JS framing
 * drifts, the snapshot test in `check-prompts.test.ts` ALSO goes red — this file
 * is the TS half + the byte-identity pin.
 */

import { describe, expect, test } from 'vitest';
import { buildNoDirectDomPrompt } from '../../src/checks/no-direct-dom.js';
import { buildNoSyncOdataPrompt } from '../../src/checks/no-sync-odata.js';
import { buildMissingTeardownPrompt } from '../../src/checks/missing-teardown.js';
import { buildGlobalsInViewsPrompt } from '../../src/checks/globals-in-views.js';
import { buildMissingCoveragePrompt } from '../../src/checks/missing-test-coverage.js';
import { buildManifestDriftPrompt } from '../../src/checks/manifest-component-drift.js';

const TS_CTRL = 'webapp/controller/App.controller.ts';
const TS_SOURCE =
  'import Controller from "sap/ui/core/mvc/Controller";\nexport default class App extends Controller {}';
const NEVER_AMD = 'NEVER rewrite the file into `sap.ui.define(...)`';

describe('GA1-10 — source-fenced check prompts are TS-framed for a TS project', () => {
  test('no-direct-dom: ```typescript fence + ES-module guidance; never ```javascript', () => {
    const ts = buildNoDirectDomPrompt({ relPath: TS_CTRL, content: TS_SOURCE, language: 'ts' });
    expect(ts).toContain('```typescript');
    expect(ts).not.toContain('```javascript');
    expect(ts).toContain(NEVER_AMD);
    expect(ts).toContain('TypeScript SAPUI5 project');
  });

  test('no-sync-odata: TS-framed', () => {
    const ts = buildNoSyncOdataPrompt({ relPath: TS_CTRL, content: TS_SOURCE, language: 'ts' });
    expect(ts).toContain('```typescript');
    expect(ts).not.toContain('```javascript');
    expect(ts).toContain(NEVER_AMD);
  });

  test('missing-teardown: TS-framed', () => {
    const ts = buildMissingTeardownPrompt({
      relPath: 'webapp/test/unit/App.controller.qunit.ts',
      content: 'import QUnit from "sap/ui/thirdparty/qunit-2";',
      language: 'ts',
    });
    expect(ts).toContain('```typescript');
    expect(ts).not.toContain('```javascript');
    expect(ts).toContain(NEVER_AMD);
  });

  test('missing-test-coverage: BOTH controller and test blocks are TS-fenced', () => {
    const ts = buildMissingCoveragePrompt({
      controllerRelPath: TS_CTRL,
      controllerContent: TS_SOURCE,
      testRelPath: 'webapp/test/unit/controller/App.controller.qunit.ts',
      testContent: 'QUnit.test("x", (a) => a.ok(true));',
      language: 'ts',
    });
    // two fenced blocks, both typescript
    expect(ts.match(/```typescript/g)?.length).toBe(2);
    expect(ts).not.toContain('```javascript');
    expect(ts).toContain(NEVER_AMD);
  });

  test('globals-in-views: the view stays ```xml; the paired controller block is ```typescript', () => {
    const ts = buildGlobalsInViewsPrompt({
      viewRelPath: 'webapp/view/App.view.xml',
      viewContent: '<mvc:View xmlns:mvc="sap.ui.core.mvc"/>',
      controllerRelPath: TS_CTRL,
      controllerContent: TS_SOURCE,
      language: 'ts',
    });
    expect(ts).toContain('```xml'); // the view is language-agnostic
    expect(ts).toContain('```typescript'); // the paired controller is TS
    expect(ts).not.toContain('```javascript');
  });

  test('manifest-component-drift: a TS project anchors webapp/Component.ts', () => {
    const ts = buildManifestDriftPrompt({
      manifest: '{"sap.app":{"type":"application"}}',
      component: 'export default class Component {}',
      componentRel: 'webapp/Component.ts',
    });
    expect(ts).toContain('webapp/Component.ts');
    expect(ts).not.toContain('webapp/Component.js');
  });
});

describe('GA1-10 — the JS framing is byte-identical (default === explicit js, no TS leakage)', () => {
  const RELPATH = 'webapp/controller/Main.controller.js';
  const SAMPLE_JS = 'sap.ui.define([], function () { return {}; });';

  const cases: ReadonlyArray<readonly [string, (lang?: 'js' | 'ts') => string]> = [
    ['no-direct-dom', (lang) => buildNoDirectDomPrompt({ relPath: RELPATH, content: SAMPLE_JS, ...(lang ? { language: lang } : {}) })],
    ['no-sync-odata', (lang) => buildNoSyncOdataPrompt({ relPath: RELPATH, content: SAMPLE_JS, ...(lang ? { language: lang } : {}) })],
    ['missing-teardown', (lang) => buildMissingTeardownPrompt({ relPath: 'webapp/test/unit/M.qunit.js', content: 'QUnit.module("M");', ...(lang ? { language: lang } : {}) })],
  ];

  for (const [name, build] of cases) {
    test(`${name}: default === language:'js', and JS uses the javascript fence with no TS guidance`, () => {
      const def = build(undefined);
      const js = build('js');
      expect(def).toBe(js);
      expect(js).toContain('```javascript');
      expect(js).not.toContain('```typescript');
      expect(js).not.toContain(NEVER_AMD);
      expect(js).not.toContain('TypeScript SAPUI5 project');
    });
  }

  test('manifest-component-drift: default anchors webapp/Component.js (byte-identical)', () => {
    const def = buildManifestDriftPrompt({ manifest: '{}', component: 'x' });
    const js = buildManifestDriftPrompt({ manifest: '{}', component: 'x', componentRel: 'webapp/Component.js' });
    expect(def).toBe(js);
    expect(def).toContain('webapp/Component.js');
    expect(def).not.toContain('webapp/Component.ts');
  });
});
