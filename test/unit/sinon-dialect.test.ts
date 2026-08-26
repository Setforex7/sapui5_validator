/**
 * V1.3.2-2 witness — pins the V1.3.2-4 contract for
 * `detectSinonDialect` (AC1 reworked four-signal precedence) and the
 * `SAP_BUNDLED_SINON_CLAUSE` text. All cases that exercise non-`'unknown'`
 * results fail against V1.3.2-2's `() => 'unknown'` identity stub with
 * specific assertion mismatches (AH5).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  SAP_BUNDLED_SINON_CLAUSE,
  SAP_BUNDLED_SINON_CLAUSE_TS,
  detectSinonDialect,
} from '../../src/project/sinon-dialect.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sapui5-sinon-dialect-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePackageJson(content: unknown): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify(content), 'utf8');
}

function writeQunitTest(relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function writeTestsuiteHtml(content: string): void {
  const dir = join(root, 'webapp', 'test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'testsuite.qunit.html'), content, 'utf8');
}

describe('detectSinonDialect — AC1 four-signal precedence', () => {
  test('signal 1: package.json devDependencies lists sinon → modern', () => {
    writePackageJson({ name: 'p', devDependencies: { sinon: '^17.0.0' } });
    expect(detectSinonDialect(root)).toBe('modern');
  });

  test('signal 1: package.json dependencies lists sinon → modern', () => {
    writePackageJson({ name: 'p', dependencies: { sinon: '^17.0.0' } });
    expect(detectSinonDialect(root)).toBe('modern');
  });

  test('signal 2: an existing .qunit.js file references "sap/ui/thirdparty/sinon" → sap-bundled (cap_try-shape)', () => {
    writePackageJson({ name: 'p' });
    writeQunitTest(
      'webapp/test/unit/controller/Foo.controller.qunit.js',
      [
        'sap.ui.define([',
        '  "sap/ui/thirdparty/sinon",',
        '  "sap/ui/thirdparty/sinon-qunit"',
        '], function () {',
        '  "use strict";',
        '  QUnit.module("Foo");',
        '});',
        '',
      ].join('\n'),
    );
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('signal 3: testsuite.qunit.html references sap/ui/thirdparty/sinon → sap-bundled', () => {
    writePackageJson({ name: 'p' });
    writeTestsuiteHtml(
      [
        '<!DOCTYPE html>',
        '<html><head>',
        '  <script src="../../resources/sap/ui/thirdparty/sinon.js"></script>',
        '</head><body></body></html>',
        '',
      ].join('\n'),
    );
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('signal 4: karma-ui5 in devDependencies (no sinon, no qunit content, no testsuite) → sap-bundled (default)', () => {
    writePackageJson({ name: 'p', devDependencies: { 'karma-ui5': '^4.0.0' } });
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('signal 4: a karma.conf.js file (no sinon, no qunit content, no testsuite) → sap-bundled (default)', () => {
    writePackageJson({ name: 'p' });
    writeFileSync(join(root, 'karma.conf.js'), 'module.exports = function () {};\n', 'utf8');
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('no signals fire → unknown', () => {
    writePackageJson({ name: 'p' });
    expect(detectSinonDialect(root)).toBe('unknown');
  });

  test('GA1-07 — signal 2 fires for a TS `.qunit.ts` test loading bundled sinon → sap-bundled', () => {
    // Fail-on-revert: before GA1-07, `listQunitFiles` only collected `.qunit.js`,
    // so a TS project's `.qunit.ts` tests were invisible to Signal-2 and this
    // project (no sinon dep, no karma config, no testsuite html) fell through to
    // `unknown`. Widening the filename filter re-arms Signal-2 for TS.
    writePackageJson({ name: 'p' });
    writeQunitTest(
      'webapp/test/unit/controller/Foo.controller.qunit.ts',
      [
        'import sinon from "sap/ui/thirdparty/sinon";',
        'QUnit.module("Foo");',
        '',
      ].join('\n'),
    );
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('GA1-07 — signal 2 also fires for a `.test.ts` file loading bundled sinon', () => {
    writePackageJson({ name: 'p' });
    writeQunitTest(
      'webapp/test/unit/controller/Foo.test.ts',
      'import sinon from "sap/ui/thirdparty/sinon";\n',
    );
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('precedence: modern wins when both modern (signal 1) and a sap-bundled signal are present', () => {
    writePackageJson({
      name: 'p',
      devDependencies: { sinon: '^17.0.0', 'karma-ui5': '^4.0.0' },
    });
    writeQunitTest(
      'webapp/test/unit/controller/Foo.controller.qunit.js',
      [
        'sap.ui.define([',
        '  "sap/ui/thirdparty/sinon"',
        '], function () {});',
        '',
      ].join('\n'),
    );
    writeTestsuiteHtml(
      '<html><head><script src="sap/ui/thirdparty/sinon.js"></script></head></html>',
    );
    expect(detectSinonDialect(root)).toBe('modern');
  });

  test('malformed package.json is swallowed; subsequent signals still resolve', () => {
    writeFileSync(join(root, 'package.json'), '{ not valid json', 'utf8');
    // No package.json sinon dep readable, no qunit reference, no html → falls
    // through to the karma-ui5 default arm. Provide a karma.conf.js to land
    // on `sap-bundled` and prove the malformed-JSON arm does not throw.
    writeFileSync(join(root, 'karma.conf.js'), 'module.exports = function () {};\n', 'utf8');
    expect(() => detectSinonDialect(root)).not.toThrow();
    expect(detectSinonDialect(root)).toBe('sap-bundled');
  });

  test('a missing project root does not throw (best-effort file reads)', () => {
    const ghost = join(tmpdir(), `sapui5-sinon-ghost-${Date.now()}`);
    expect(() => detectSinonDialect(ghost)).not.toThrow();
    expect(detectSinonDialect(ghost)).toBe('unknown');
  });
});

describe('SAP_BUNDLED_SINON_CLAUSE — text pinned for V1.3.2-4', () => {
  test('clause names sinon 1.17 and forbids the 2.x APIs cap_try tripped over', () => {
    // The stub is the empty string. V1.3.2-4 must replace it with the
    // sap-bundled sinon clause; this witness pins the load-bearing tokens
    // (the sinon version we steer toward, the 2.x APIs that burned cap_try,
    // and the sandbox-creation API that works in 1.17). A typo like
    // "calsFake" or "sinon.createSandbox" surviving where it shouldn't is
    // caught here — the plan-§4.4 "inline snapshot pin" purpose served
    // through targeted substring assertions on the load-bearing tokens.
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('sap/ui/thirdparty/sinon');
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('1.17');
    // 2.x APIs we must steer the LLM AWAY from.
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('callsFake');
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('.resolves');
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('.rejects');
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('createSandbox');
    // 1.17 APIs we must steer the LLM TOWARD.
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('sinon.sandbox.create');
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('.returns');
    // The text is non-trivial — well above the empty stub.
    expect(SAP_BUNDLED_SINON_CLAUSE.length).toBeGreaterThan(400);
  });

  test('V1.4-8 (Bug B1) — clause forbids sinon-qunit (cap_try ProductService "sinon is not defined")', () => {
    // The cap_try ProductService quarantine came from the LLM importing
    // sap/ui/thirdparty/sinon-qunit during refinement; the bundled sinon
    // module registers no global `sinon`, so sinon-qunit throws at load.
    // The clause must name the forbidden module and the symptom.
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('sap/ui/thirdparty/sinon-qunit');
    expect(SAP_BUNDLED_SINON_CLAUSE).toContain('sinon is not defined');
  });
});

describe('SAP_BUNDLED_SINON_CLAUSE_TS — text pinned for V1.9.3 D4', () => {
  test('the TS clause wires sinon as an ES-module import, NOT the AMD array form', () => {
    // V1.9.3 D4 — the JS clause mandates AMD ("Depend on … in the sap.ui.define
    // array"), which contradicts the anti-AMD TS prompt. The TS twin must express
    // the module wiring as an ES `import` and must NOT carry the AMD-mandating
    // "sap.ui.define array" instruction. Reverting to the JS clause (or letting
    // the AMD phrase leak into the TS clause) flips these assertions RED.
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain(
      'import sinon from "sap/ui/thirdparty/sinon"',
    );
    // The distinctive AMD-mandating phrase from SAP_BUNDLED_SINON_CLAUSE must be
    // absent from the TS twin (the heart of D4).
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).not.toContain('sap.ui.define array');
  });

  test('the TS clause keeps the 1.17-vs-2.x API guidance (the load-bearing, language-neutral part)', () => {
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('sap/ui/thirdparty/sinon');
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('1.17');
    // 2.x APIs we must steer the LLM AWAY from.
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('callsFake');
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('.resolves');
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('.rejects');
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('createSandbox');
    // 1.17 APIs we must steer the LLM TOWARD.
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('sinon.sandbox.create');
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('.returns');
    // And the sinon-qunit warning carries over (still wrong on the bundled sinon).
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('sap/ui/thirdparty/sinon-qunit');
    expect(SAP_BUNDLED_SINON_CLAUSE_TS).toContain('sinon is not defined');
    // Non-trivial text, well above an empty stub.
    expect(SAP_BUNDLED_SINON_CLAUSE_TS.length).toBeGreaterThan(300);
  });
});
