/**
 * V1.9.4 PERF-3 / PERF-11 — generate-prompt trimming (fail-on-revert guards).
 *
 *   - PERF-3: the embedded controller source is passed through `stripJsComments`
 *     in the initial QUnit prompt (JS + TS) and the initial OPA5 prompt — PROMPT
 *     ONLY (the on-disk file + audit transcript keep the raw bytes; those paths
 *     are covered elsewhere). Comment markers inside string literals survive.
 *   - PERF-11: the OPA5 initial prompt embeds a regex SURFACE SUMMARY of the view
 *     (root tag + every `id`/`press`/bound `text` at ALL depths), not the full
 *     view XML.
 *
 * Each test goes RED if its trim is reverted: a stripped comment reappears, or the
 * full view XML (a non-surface attribute) reappears in the OPA5 prompt.
 */

import { describe, expect, test } from 'vitest';
import { buildInitialQunitPrompt } from '../../src/generation/qunit.js';
import { buildInitialOpa5Prompt, summarizeViewSurface } from '../../src/generation/opa5.js';

describe('PERF-3 — stripJsComments on the embedded controller source (prompt only)', () => {
  test('JS initial QUnit prompt: line + block comments are stripped, code survives', () => {
    const content = [
      'sap.ui.define([], function () {',
      '  // SECRET_LINE_COMMENT — remove me',
      '  /* SECRET_BLOCK_COMMENT */',
      '  return { onInit: function () {} };',
      '});',
    ].join('\n');
    const prompt = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/Main.controller.js',
      controllerContent: content,
      expectedTestRel: 'webapp/test/unit/controller/Main.controller.qunit.js',
      namespace: 'demo.app',
      sinonDialect: 'unknown',
    });
    expect(prompt).not.toContain('SECRET_LINE_COMMENT');
    expect(prompt).not.toContain('SECRET_BLOCK_COMMENT');
    // The code itself is preserved (stripping is length-preserving, not deletion).
    expect(prompt).toContain('onInit');
    expect(prompt).toContain('```javascript');
  });

  test('a comment marker INSIDE a string literal is NOT stripped (string-aware)', () => {
    const content = [
      'sap.ui.define([], function () {',
      '  var url = "http://example.com/safe"; // STRIP_THIS_TAIL',
      '  return {};',
      '});',
    ].join('\n');
    const prompt = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/Main.controller.js',
      controllerContent: content,
      expectedTestRel: 'webapp/test/unit/controller/Main.controller.qunit.js',
      namespace: 'demo.app',
      sinonDialect: 'unknown',
    });
    // The `//` inside the string literal must survive verbatim...
    expect(prompt).toContain('"http://example.com/safe"');
    // ...while the genuine trailing comment is stripped.
    expect(prompt).not.toContain('STRIP_THIS_TAIL');
  });

  test('TS initial QUnit prompt also strips comments (typescript fence)', () => {
    const content = [
      'import Controller from "sap/ui/core/mvc/Controller";',
      '// TS_SECRET_COMMENT',
      'export default class App extends Controller { public onInit(): void {} }',
    ].join('\n');
    const prompt = buildInitialQunitPrompt({
      controllerRel: 'webapp/controller/App.controller.ts',
      controllerContent: content,
      expectedTestRel: 'webapp/test/unit/controller/App.controller.qunit.ts',
      namespace: 'e2e.real.ts',
      sinonDialect: 'unknown',
      projectLanguage: 'ts',
    });
    expect(prompt).toContain('```typescript');
    expect(prompt).not.toContain('TS_SECRET_COMMENT');
    expect(prompt).toContain('export default class App');
  });

  test('OPA5 initial prompt strips comments from the embedded controller', () => {
    const prompt = buildInitialOpa5Prompt({
      namespace: 'demo.app',
      viewRel: 'webapp/view/Main.view.xml',
      viewName: 'Main',
      viewContent: '<mvc:View xmlns:mvc="sap.ui.core.mvc"><Button id="b" /></mvc:View>',
      controllerRel: 'webapp/controller/Main.controller.js',
      controllerContent: 'sap.ui.define([], function () { /* OPA_SECRET */ return {}; });',
      journeyRel: 'webapp/test/integration/MainJourney.qunit.js',
    });
    expect(prompt).not.toContain('OPA_SECRET');
  });
});

describe('PERF-11 — OPA5 view surface summary', () => {
  test('summarizeViewSurface captures the root tag + id/press/bound-text at ALL depths', () => {
    const view = [
      '<mvc:View controllerName="demo.app.controller.Main" xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc">',
      '  <Page id="rootPage" title="Literal Title Not Bound">',
      '    <content>',
      '      <VBox>',
      '        <Button id="deepBtn" press=".onDeepPress" text="{i18n>deep}" />',
      '        <Input id="nested.input" value="{/path}" />',
      '        <Text text="literal unbound text" />',
      '      </VBox>',
      '    </content>',
      '  </Page>',
      '</mvc:View>',
    ].join('\n');
    const summary = summarizeViewSurface(view);
    // Root control type.
    expect(summary).toContain('mvc:View');
    // ids at depth 1 AND deeper (the all-depth guarantee — reverting to a
    // shallow/tree-truncated scan drops the deep ones → RED).
    expect(summary).toContain('rootPage');
    expect(summary).toContain('deepBtn');
    expect(summary).toContain('nested.input');
    // press handler (deep).
    expect(summary).toContain('.onDeepPress');
    // BOUND text only.
    expect(summary).toContain('{i18n>deep}');
    expect(summary).not.toContain('literal unbound text');
    expect(summary).not.toContain('Literal Title Not Bound');
  });

  test('a commented-out element does not leak a phantom id into the summary', () => {
    const view = [
      '<mvc:View xmlns:mvc="sap.ui.core.mvc">',
      '  <!-- <Button id="ghostId" press=".ghostPress" /> -->',
      '  <Button id="realId" />',
      '</mvc:View>',
    ].join('\n');
    const summary = summarizeViewSurface(view);
    expect(summary).toContain('realId');
    expect(summary).not.toContain('ghostId');
    expect(summary).not.toContain('.ghostPress');
  });

  test('the OPA5 initial prompt embeds the SUMMARY, not the full view XML', () => {
    const view =
      '<mvc:View xmlns:mvc="sap.ui.core.mvc">' +
      '<Button id="okBtn" press=".onOk" />' +
      '<Image src="UNNEEDED_LAYOUT_DETAIL" width="320px" />' +
      '</mvc:View>';
    const prompt = buildInitialOpa5Prompt({
      namespace: 'demo.app',
      viewRel: 'webapp/view/Main.view.xml',
      viewName: 'Main',
      viewContent: view,
      controllerRel: 'webapp/controller/Main.controller.js',
      controllerContent: 'sap.ui.define([], function () { return {}; });',
      journeyRel: 'webapp/test/integration/MainJourney.qunit.js',
    });
    // The surface the journey needs is present...
    expect(prompt).toContain('View surface');
    expect(prompt).toContain('okBtn');
    expect(prompt).toContain('.onOk');
    // ...but the full-XML layout detail (a non-surface attribute) is gone, and so
    // is the raw XML fence (reverting to the verbatim embed brings both back → RED).
    expect(prompt).not.toContain('UNNEEDED_LAYOUT_DETAIL');
    expect(prompt).not.toContain('```xml');
    // The OPA5 task framing + requirements are intact.
    expect(prompt).toContain('Task: generate an OPA5 journey');
    expect(prompt).toContain('iTeardownMyApp');
  });
});
