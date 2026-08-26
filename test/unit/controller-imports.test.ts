import { describe, expect, test } from 'vitest';
import {
  parseControllerImports,
  parseEsModuleImports,
} from '../../src/project/controller-imports.js';

/**
 * Witnesses for `parseControllerImports` — a single-pass, comment- and
 * string-aware scanner over a controller's `sap.ui.define([...])` import
 * array. V1.4-11 adds the commented-define-head cases (the head is now
 * located over comment-masked content).
 */

describe('parseControllerImports', () => {
  test('canonical single-line shape', () => {
    const content = `sap.ui.define(["a", "b"], function (A, B) { return {}; });`;
    expect(parseControllerImports(content)).toEqual(['a', 'b']);
  });

  test('multi-line array with indentation', () => {
    const content = [
      'sap.ui.define([',
      '  "sap/ui/core/mvc/Controller",',
      '  "sap/m/MessageToast",',
      '  "sap/ui/export/Spreadsheet"',
      '], function (Controller, MessageToast, Spreadsheet) {',
      '  return Controller.extend("foo", {});',
      '});',
      '',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual([
      'sap/ui/core/mvc/Controller',
      'sap/m/MessageToast',
      'sap/ui/export/Spreadsheet',
    ]);
  });

  test('single-quoted strings', () => {
    const content = `sap.ui.define(['a', 'b'], function (A, B) { return {}; });`;
    expect(parseControllerImports(content)).toEqual(['a', 'b']);
  });

  test('comments inside the import array do not appear as imports', () => {
    const content = [
      'sap.ui.define([',
      '  "sap/m/Button", // trailing comment',
      '  /* block */ "sap/m/Dialog"',
      '], function (Button, Dialog) {});',
    ].join('\n');
    const result = parseControllerImports(content);
    expect(result).toEqual(['sap/m/Button', 'sap/m/Dialog']);
  });

  test('AH1 — string literal containing a closing bracket does not terminate the array (inline scanner tracks in-string state)', () => {
    const content = `sap.ui.define(["path/to/[weird]"], function () {});`;
    expect(parseControllerImports(content)).toEqual(['path/to/[weird]']);
  });

  test('V1.4-11 — a commented-out sap.ui.define above the live one does not hijack the parse', () => {
    const content = [
      '// sap.ui.define(["sap/ui/export/Spreadsheet"], function () {});',
      'sap.ui.define(["sap/m/Button"], function (Button) {});',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual(['sap/m/Button']);
  });

  test('V1.4-11 — a JSDoc @example block-comment sap.ui.define does not hijack the parse', () => {
    const content = [
      '/**',
      ' * @example',
      ' * sap.ui.define(["sap/evil/Thing"], function () {});',
      ' */',
      'sap.ui.define([',
      '  "sap/ui/core/mvc/Controller",',
      '  "sap/m/Text"',
      '], function (Controller, Text) {});',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual([
      'sap/ui/core/mvc/Controller',
      'sap/m/Text',
    ]);
  });

  test('V1.4-11 — a `//`-sequence inside a string literal is not mistaken for a comment when finding the head', () => {
    // The first textual `sap.ui.define([` is the real one; the earlier line
    // contains a `//` inside a string, which must NOT mask the rest of the
    // line as a comment.
    const content = [
      'const u = "https://example.com/x";',
      'sap.ui.define(["sap/m/Button"], function (Button) {});',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual(['sap/m/Button']);
  });

  test('no sap.ui.define call returns empty', () => {
    const content = `function helper() { return 1; }`;
    expect(parseControllerImports(content)).toEqual([]);
  });

  test('COR-5 — a `sap.ui.define([...])` inside a regex literal does not fabricate imports', () => {
    // A helper module whose only textual `sap.ui.define([` lives inside a regex
    // literal (e.g. a tiny source-scanner). Pre-COR-5 the head matched the
    // regex body and the scanner read its quoted text as a real import →
    // a phantom unpreloaded-lib gap. The head search now masks regex bodies.
    const content = [
      'function findDefine(src) {',
      "  return src.match(/sap.ui.define([ 'sap/m/Button' ])/);",
      '}',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual([]);
  });

  test('COR-5 — a later regex containing the head text does not shadow the real define', () => {
    const content = [
      'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
      "  var re = /sap.ui.define([ 'sap/evil/Thing' ])/;",
      '  return Controller.extend("x", { re: re });',
      '});',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual(['sap/ui/core/mvc/Controller']);
  });

  test('sap.ui.define without an array (factory-only) returns empty', () => {
    const content = `sap.ui.define(function () { return {}; });`;
    expect(parseControllerImports(content)).toEqual([]);
  });

  test('preserves first-occurrence order across duplicates', () => {
    const content = [
      'sap.ui.define([',
      '  "sap/m/Button",',
      '  "sap/m/Dialog",',
      '  "sap/m/Button"',
      '], function (Button, Dialog) {});',
    ].join('\n');
    expect(parseControllerImports(content)).toEqual(['sap/m/Button', 'sap/m/Dialog']);
  });
});

/**
 * V1.9 GA1-03 — the hand-rolled ES-module import parser for TypeScript-SAPUI5
 * controllers. A TS controller has NO `sap.ui.define([...])` head, so the JS
 * parser above returns `[]` for it (the silent zero-result that makes the
 * unpreloaded-libs spine inert for TS). These witnesses pin that the ES parser
 * extracts the same bare module-id shape the JS parser produces — and the
 * fail-on-revert case proves the JS parser is genuinely inert on TS source.
 */
describe('parseEsModuleImports (V1.9 GA1-03)', () => {
  const TS_CONTROLLER = [
    'import MessageBox from "sap/m/MessageBox";',
    'import Controller from "sap/ui/core/mvc/Controller";',
    '',
    '/** @namespace ui5.typescript.helloworld.controller */',
    'export default class App extends Controller {',
    '  public sayHello(): void { MessageBox.show("Hello World!"); }',
    '}',
    '',
  ].join('\n');

  test('the canonical TS controller shape — default imports', () => {
    expect(parseEsModuleImports(TS_CONTROLLER)).toEqual([
      'sap/m/MessageBox',
      'sap/ui/core/mvc/Controller',
    ]);
  });

  test('FAIL-ON-REVERT teeth: the JS sap.ui.define parser is INERT on TS source; the ES parser is not', () => {
    // This is the GA1-03 hole made explicit. Routing a TS controller through
    // the `sap.ui.define`-only parser (the pre-V1.9 path) finds no head and
    // returns [] — the unpreloaded-libs spine sees "imports nothing" and never
    // fires. The ES parser recovers the real imports. Reverting the dependency-
    // graph route back to `parseControllerImports` for TS makes any downstream
    // gap witness go RED, because THIS returns [].
    expect(parseControllerImports(TS_CONTROLLER)).toEqual([]);
    expect(parseEsModuleImports(TS_CONTROLLER).length).toBeGreaterThan(0);
  });

  test('named imports with aliases: import { a, b as c } from "mod"', () => {
    const content = 'import { Button, Dialog as D } from "sap/m/library";';
    expect(parseEsModuleImports(content)).toEqual(['sap/m/library']);
  });

  test('namespace import: import * as ns from "mod"', () => {
    const content = 'import * as core from "sap/ui/core/library";';
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/library']);
  });

  test('side-effect import: import "mod"', () => {
    const content = 'import "sap/ui/core/sample/Bar";';
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/sample/Bar']);
  });

  test('combined default + named: import Default, { a } from "mod"', () => {
    const content = 'import Controller, { Route } from "sap/ui/core/routing/Router";';
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/routing/Router']);
  });

  test('single-quoted specifiers are read identically', () => {
    expect(parseEsModuleImports("import X from 'sap/m/Text';")).toEqual(['sap/m/Text']);
  });

  test('relative specifiers (./, ../) are excluded — they are intra-project, not libraries', () => {
    const content = [
      'import MessageBox from "sap/m/MessageBox";',
      'import AppComponent from "../Component";',
      'import { fmt } from "./util/formatter";',
    ].join('\n');
    expect(parseEsModuleImports(content)).toEqual(['sap/m/MessageBox']);
  });

  test('type-only imports are excluded (erased at transpile, no runtime load)', () => {
    const content = [
      'import type Metadata from "sap/ui/core/Element";',
      'import type { Route } from "sap/ui/core/routing/Router";',
      'import type * as types from "sap/m/library";',
      'import Controller from "sap/ui/core/mvc/Controller";',
    ].join('\n');
    // Only the value import survives; the three `import type` heads are erased.
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/mvc/Controller']);
  });

  test('`type` as a binding NAME is NOT type-only and IS counted', () => {
    // `import type from 'm'` is a default import of a binding literally named
    // `type`; `import type, { x }` likewise. Both load the module at runtime.
    expect(parseEsModuleImports('import type from "sap/m/Button";')).toEqual(['sap/m/Button']);
    expect(parseEsModuleImports('import type, { x } from "sap/m/Bar";')).toEqual(['sap/m/Bar']);
  });

  test('dynamic import(...) and import.meta are not static imports', () => {
    const content = [
      'const m = import("sap/m/MessageBox");',
      'const u = import.meta.url;',
      'import Controller from "sap/ui/core/mvc/Controller";',
    ].join('\n');
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/mvc/Controller']);
  });

  test('a `from` used as an imported name does not end the clause early', () => {
    const content = 'import { from as origin, to } from "sap/ui/core/routing/Target";';
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/routing/Target']);
  });

  test('a commented-out import does not parse', () => {
    const content = [
      '// import Evil from "sap/evil/Thing";',
      '/* import Other from "sap/other/Thing"; */',
      'import Controller from "sap/ui/core/mvc/Controller";',
    ].join('\n');
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/mvc/Controller']);
  });

  test('an `import` token inside a string literal is not parsed as a statement', () => {
    const content = [
      'const doc = "import Foo from \'sap/evil/Thing\'";',
      'import Controller from "sap/ui/core/mvc/Controller";',
    ].join('\n');
    expect(parseEsModuleImports(content)).toEqual(['sap/ui/core/mvc/Controller']);
  });

  test('first-occurrence order is preserved across duplicates', () => {
    const content = [
      'import Button from "sap/m/Button";',
      'import Dialog from "sap/m/Dialog";',
      'import { Button as B2 } from "sap/m/Button";',
    ].join('\n');
    expect(parseEsModuleImports(content)).toEqual(['sap/m/Button', 'sap/m/Dialog']);
  });

  test('no imports → empty', () => {
    expect(parseEsModuleImports('export default class X {}')).toEqual([]);
  });
});
