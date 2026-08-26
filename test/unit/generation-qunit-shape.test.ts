import { describe, expect, test } from 'vitest';
import { checkTsTestShape } from '../../src/generation/qunit.js';

/**
 * V1.9.2 (TG-ACCEPT / HB-VACUOUS, FS-11) — the shape gate for a generated
 * `.qunit.ts`. `tsc --noEmit` proves the test type-checks but NOT that it
 * asserts anything, so static acceptance additionally requires: (a) a
 * `QUnit.test`, (b) an assertion, and (c) a reference to the controller under
 * test by its ES module id. Reverting any clause lets a vacuous test through →
 * the matching case here goes RED.
 */
describe('checkTsTestShape', () => {
  const id = 'ui5/typescript/helloworld/controller/App.controller';

  test('a well-formed test (import + QUnit.test + assertion) is accepted', () => {
    const content = [
      `import App from "${id}";`,
      'QUnit.module("App");',
      'QUnit.test("constructs", function (assert) {',
      '  const controller = new App();',
      '  assert.ok(controller, "controller constructs");',
      '});',
      '',
    ].join('\n');
    expect(checkTsTestShape(content, id)).toEqual({ ok: true });
  });

  test('arrow-style assertions and whitespace variants are accepted', () => {
    const content = [
      `import App from "${id}";`,
      'QUnit . test ("onInit", (assert) => {',
      '  const c = new App();',
      '  assert . strictEqual (typeof c.onInit, "function");',
      '});',
      '',
    ].join('\n');
    expect(checkTsTestShape(content, id)).toEqual({ ok: true });
  });

  test('a vacuous test (assert.ok(true), no controller reference) is rejected', () => {
    const content =
      'QUnit.test("loads", function (assert) { assert.ok(true); });\n';
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/reference to the controller/i);
      expect(result.reason).toContain(id);
    }
  });

  test('an empty-body test (QUnit.test but no assertion) is rejected', () => {
    const content = [
      `import App from "${id}";`,
      'QUnit.test("noop", function () { /* nothing */ });',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/assertion/i);
  });

  test('a module with assertions but no QUnit.test is rejected', () => {
    const content = [
      `import App from "${id}";`,
      'const c = new App();',
      'assert.ok(c);',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/QUnit\.test/i);
  });

  test('a controller reference hidden in a comment does not satisfy the gate', () => {
    // The id appears only in a comment; the real code is vacuous → rejected.
    const content = [
      `// references ${id}`,
      'QUnit.test("loads", function (assert) { assert.ok(true); });',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reference to the controller/i);
  });

  /**
   * V1.9.3 D5 (LOW — false-rejection) — condition (a)'s regex must accept the
   * standard QUnit filter forms `QUnit.test.only` / `QUnit.test.skip`. Before the
   * widen, `/\bQUnit\s*\.\s*test\s*\(/u` matched only `QUnit.test(`, so a valid
   * type-checking `.only`/`.skip` test was rejected as "no QUnit.test block".
   * Fail-on-revert: revert the regex and these two cases go RED.
   */
  test('D5 — a QUnit.test.only(...) test (with assertion + pinned id) is accepted', () => {
    const content = [
      `import App from "${id}";`,
      'QUnit.module("App");',
      'QUnit.test.only("constructs", function (assert) {',
      '  const controller = new App();',
      '  assert.ok(controller, "controller constructs");',
      '});',
      '',
    ].join('\n');
    expect(checkTsTestShape(content, id)).toEqual({ ok: true });
  });

  test('D5 — a QUnit.test.skip(...) test (with assertion + pinned id) is accepted', () => {
    const content = [
      `import App from "${id}";`,
      'QUnit.module("App");',
      'QUnit.test.skip("constructs", function (assert) {',
      '  const controller = new App();',
      '  assert.ok(controller, "controller constructs");',
      '});',
      '',
    ].join('\n');
    expect(checkTsTestShape(content, id)).toEqual({ ok: true });
  });

  /**
   * V1.9.3 D3 (MEDIUM — false-rejection reason) — a test that DOES exercise the
   * controller but imports it by a *relative specifier* (or tsconfig alias) is a
   * wrong-id conformance miss, NOT a vacuous test. Before the fix, condition (c)'s
   * substring miss assembled a reason calling it "vacuous (proves nothing about
   * the controller)" and steered refinement to "add assertions" — factually wrong
   * and mis-guiding. The fix keeps the exact-id REQUIREMENT (still rejected — the
   * gate is unchanged in strictness) but the reason must name the exact-id
   * requirement and must NOT say "vacuous". Fail-on-revert: revert the message and
   * `.not.toMatch(/vacuous/i)` goes RED.
   */
  test('D3 — a relative-specifier controller import is a wrong-id miss, not "vacuous"', () => {
    const content = [
      'import App from "../../controller/App.controller";',
      'QUnit.module("App");',
      'QUnit.test("constructs", function (assert) {',
      '  const controller = new App();',
      '  assert.ok(controller, "controller constructs");',
      '});',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false); // condition (c)'s requirement is unchanged
    if (!result.ok) {
      expect(result.reason).not.toMatch(/vacuous/i);
      expect(result.reason).toMatch(/exact/i); // names the exact-id requirement
      expect(result.reason).toContain(id);
    }
  });

  /**
   * V1.9.3 D3 — the non-gameable guard (FS-11) is preserved: a `QUnit.test` +
   * `assert.ok(true)` that never references the controller in any form (not the
   * exact id, not a basename-suffix path) stays rejected AND is honestly called
   * vacuous (it really does prove nothing about the controller).
   */
  test('D3 — a controller-less assert.ok(true) test stays rejected as vacuous', () => {
    const content =
      'QUnit.test("loads", function (assert) { assert.ok(true); });\n';
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/vacuous/i);
      expect(result.reason).toMatch(/reference to the controller/i);
    }
  });

  /**
   * V1.9.9 condition (d) — a qunit-2 import is tsc-green (`@sapui5/types`
   * declares the module) but double-defines QUnit at runtime next to the
   * testsuite HTML's `<script src=".../qunit-2.js">` tag, killing the whole
   * suite. The gate rejects ANY mention of the specifier (post comment-strip),
   * and the rejection composes into ONE feedback message with the other
   * conditions (3 attempts must not be burned one-defect-at-a-time).
   * Fail-on-revert: delete `importsQunit2` and every case below goes RED.
   */
  test('(d) — an otherwise-perfect test with a default qunit-2 import is rejected, not called vacuous', () => {
    const content = [
      'import QUnit from "sap/ui/thirdparty/qunit-2";',
      `import App from "${id}";`,
      'QUnit.module("App");',
      'QUnit.test("constructs", function (assert) {',
      '  const controller = new App();',
      '  assert.ok(controller, "controller constructs");',
      '});',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('sap/ui/thirdparty/qunit-2');
      expect(result.reason).toMatch(/second time|double/i);
      expect(result.reason).toMatch(/QUnit global directly/i);
      // The import is the ONLY defect — no vacuous/wrong-id steer may leak in.
      expect(result.reason).not.toMatch(/vacuous/i);
      expect(result.reason).not.toMatch(/exact pinned module id/i);
      // The model must not over-generalise the ban onto the sinon import.
      expect(result.reason).toMatch(/sinon import .* must stay/i);
    }
  });

  test('(d) — a side-effect qunit-2 import is rejected too (raw-substring, any spelling)', () => {
    const content = [
      'import "sap/ui/thirdparty/qunit-2";',
      `import App from "${id}";`,
      'QUnit.test("constructs", (assert) => {',
      '  assert.ok(new App());',
      '});',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('sap/ui/thirdparty/qunit-2');
  });

  test('(d) — qunit-2 import + vacuous body → ONE combined reason naming both defects', () => {
    const content = [
      'import QUnit from "sap/ui/thirdparty/qunit-2";',
      'QUnit.test("loads", function (assert) { assert.ok(true); });',
      '',
    ].join('\n');
    const result = checkTsTestShape(content, id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Both steers in a single feedback message (one refinement round).
      expect(result.reason).toMatch(/vacuous/i);
      expect(result.reason).toContain('sap/ui/thirdparty/qunit-2');
    }
  });

  test('(d) — a qunit-2 mention only in a comment does not trip the gate', () => {
    const content = [
      '// do NOT import sap/ui/thirdparty/qunit-2 here',
      `import App from "${id}";`,
      'QUnit.test("constructs", function (assert) {',
      '  assert.ok(new App());',
      '});',
      '',
    ].join('\n');
    expect(checkTsTestShape(content, id)).toEqual({ ok: true });
  });
});
