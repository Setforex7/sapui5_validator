/**
 * V1.5 #A4 — `stripJsComments` baseline contract + regex-literal awareness.
 *
 * The A4 fix adds a conservative regex-literal state so a `/.../ ` containing a
 * quote no longer flips the scanner into a phantom string state (which swallowed
 * a trailing comment and any following real config). These tests pin both the
 * new regex handling AND that division is NOT misread as a regex — the failure
 * mode a too-eager heuristic would introduce.
 */
import { describe, expect, test } from 'vitest';
import { stripJsComments } from '../../src/util/strip-js-comments.js';

describe('stripJsComments — maskRegexLiterals (COR-5)', () => {
  test('default leaves a regex-literal body intact', () => {
    const src = 'var re = /sap\\.ui\\.define/;';
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain('sap');
  });

  test('opt-in blanks the whole regex literal to spaces, length-preserving', () => {
    const src = "var re = /sap.ui.define(['sap/m/Button'])/; var keep = 1;";
    const out = stripJsComments(src, { maskRegexLiterals: true });
    expect(out).toHaveLength(src.length);
    // The regex body — including the `sap.ui.define([` text and the quoted
    // module id inside it — is gone...
    expect(out).not.toContain('sap.ui.define');
    expect(out).not.toContain('sap/m/Button');
    // ...but code before and after the literal survives unchanged.
    expect(out).toContain('var re = ');
    expect(out).toContain('var keep = 1;');
  });

  test('a division `/` (postfix position) is NOT masked', () => {
    const src = 'var x = a / b; var y = 2;';
    const out = stripJsComments(src, { maskRegexLiterals: true });
    expect(out).toBe(src); // no regex literal present → identity
  });
});

describe('stripJsComments — comments and strings (baseline contract)', () => {
  test('blanks a line comment and preserves length', () => {
    const src = 'var x = 1; // tail';
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain('var x = 1;');
    expect(out).not.toContain('// tail');
  });

  test('blanks a block comment but keeps interior newlines', () => {
    const src = 'a /* c1\n c2 */ b';
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain('c1');
    expect(out.split('\n')).toHaveLength(2); // newline inside the block comment is kept
  });

  test('a // inside a string literal is not a comment', () => {
    const src = 'var s = "http://x"; // real';
    const out = stripJsComments(src);
    expect(out).toContain('"http://x"');
    expect(out).not.toContain('// real');
  });
});

describe('stripJsComments — regex-literal awareness (A4)', () => {
  test('a regex literal with a quote does not swallow a trailing comment', () => {
    const src = "var re = /(['\"])/; // tail";
    const out = stripJsComments(src);
    expect(out).toContain("/(['\"])/"); // regex body preserved verbatim
    expect(out).not.toContain('// tail');
  });

  test('a / inside a regex character class is not the closing delimiter', () => {
    const src = 'var re = /[/]/; // tail';
    const out = stripJsComments(src);
    expect(out).toContain('/[/]/');
    expect(out).not.toContain('// tail');
  });

  test('a regex right after return is recognised (quote inside stays inert)', () => {
    const src = 'function f(){ return /a"b/.test(x); } // tail';
    const out = stripJsComments(src);
    expect(out).toContain('/a"b/');
    expect(out).not.toContain('// tail');
  });

  test('a regex argument after ( does not corrupt following config', () => {
    const src = "x.replace(/['\"]/g, ''); var libs = ['sap.m']; // tail";
    const out = stripJsComments(src);
    expect(out).toContain("['sap.m']"); // the real array survives intact
    expect(out).not.toContain('// tail');
  });

  test('division is NOT treated as a regex (operands preserved)', () => {
    const src = 'var r = total / count / 2; // tail';
    const out = stripJsComments(src);
    expect(out).toContain('total / count / 2');
    expect(out).not.toContain('// tail');
  });

  test('divide-assign is NOT treated as a regex', () => {
    const src = 'acc /= step; var s = "x"; // tail';
    const out = stripJsComments(src);
    expect(out).toContain('acc /= step;');
    expect(out).toContain('"x"');
    expect(out).not.toContain('// tail');
  });

  test('length preservation holds with regex literals present', () => {
    const src = "a(/['\"]/); b /= 2; // tail";
    expect(stripJsComments(src)).toHaveLength(src.length);
  });
});

/**
 * V1.9 GA1-09 — TypeScript audit witness (no lexer rewrite). Comments, strings,
 * and template literals are lexically identical in JS and TS, so the masker is
 * correct on TS source for the surfaces it actually runs over (karma-config
 * object literals + import arrays). These pin the works-as-is cases AND the one
 * documented residual: the regex-vs-division heuristic misclassifies a `/` that
 * follows a generic-closing `>`. See the module JSDoc for the bound.
 */
describe('stripJsComments — TypeScript audit (GA1-09)', () => {
  test('TS generic + string array: globs preserved and trailing comment masked (the real surface)', () => {
    const src = "const ids: Array<string> = ['webapp/test/**/*.qunit.ts']; // trailing";
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain("'webapp/test/**/*.qunit.ts'"); // the glob survives
    expect(out).not.toContain('trailing'); // the comment is masked
  });

  test('a TS `as` cast does not corrupt comment/string masking', () => {
    const src = 'const root = (cfg as Config).files[0]; // note';
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain('cfg as Config');
    expect(out).not.toContain('note');
  });

  test('RESIDUAL BOUND: a `/` right after a generic-closing `>` is misread as a regex start', () => {
    // `arr<T>` then `/` — the scanner has no type awareness, and `>` is a
    // regex-prefix punct (it is a JS comparison/shift operator), so the division
    // `/` is classified as a regex literal. The first `/` of the trailing `//`
    // is then consumed as the regex's closing delimiter, and the comment text
    // LEAKS instead of being masked. This is the documented GA1-09 residual: it
    // is harmless on the karma-config/import-array surfaces (which never place a
    // generic-closing `>` immediately before a division `/`) and would need a
    // type-aware lexer to fix (out of V1.9 scope). Pinned so a future change is
    // a signal, not a silent behavioural drift.
    const src = 'const r = arr<T> / 2; // tail';
    const out = stripJsComments(src);
    expect(out).toHaveLength(src.length); // length invariant always holds
    expect(out).toContain('tail'); // residual: the comment is NOT masked
  });
});
