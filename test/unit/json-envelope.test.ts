/**
 * V1.3.3-3 witness — `extractJsonValue` contract for the prose-preamble
 * recovery extractor (Bug A). The V1.3.3-3 identity stub returns
 * `{ json: undefined, preamble: '' }` on any `JSON.parse` failure (AC2);
 * the V1.3.3-4 implementation replaces it with a balanced-block,
 * string-literal-aware extractor that throws `JsonExtractionError` for
 * irrecoverable inputs (AC1 fence rejection, AH2 multi-block refusal,
 * AH5 first-in-document-order pin paired with `extractFailedModule`).
 *
 * Each case pins a specific contract surface — the failing cases below
 * fail with assertion mismatches against the stub's sentinel, never with
 * setup crashes or unresolved imports (AH5 lesson V1.3.2-2 established).
 */

import { describe, expect, test } from 'vitest';
import {
  extractJsonValue,
  JsonExtractionError,
} from '../../src/util/json-envelope.js';

describe('extractJsonValue — happy path (no recovery needed)', () => {
  test('clean object passthrough → preamble undefined', () => {
    const result = extractJsonValue('{"a":1}');
    expect(result.json).toEqual({ a: 1 });
    expect(result.preamble).toBeUndefined();
  });

  test('clean array passthrough → preamble undefined', () => {
    const result = extractJsonValue('[1,2,3]');
    expect(result.json).toEqual([1, 2, 3]);
    expect(result.preamble).toBeUndefined();
  });

  test('string literal containing { } — JSON.parse handles balanced detection', () => {
    const result = extractJsonValue('{"k":"a }{ b"}');
    expect(result.json).toEqual({ k: 'a }{ b' });
  });

  test('string literal containing escaped quotes', () => {
    const result = extractJsonValue('{"k":"x\\"y"}');
    expect(result.json).toEqual({ k: 'x"y' });
  });

  test('nested objects', () => {
    const result = extractJsonValue('{"a":{"b":{"c":1}}}');
    expect(result.json).toEqual({ a: { b: { c: 1 } } });
  });

  test('nested arrays', () => {
    const result = extractJsonValue('[[1,[2,3]],[4]]');
    expect(result.json).toEqual([[1, [2, 3]], [4]]);
  });
});

describe('extractJsonValue — preamble recovery (Bug A; cap_try Shop shape)', () => {
  test('cap_try Shop shape (the load-bearing case): leading prose + object body', () => {
    const input =
      'The issue: controller-module-id mismatch.\n\n' +
      '{"newFileContent":"sap.ui.define([],function(){});"}';
    const result = extractJsonValue(input);
    expect(result.json).toEqual({
      newFileContent: 'sap.ui.define([],function(){});',
    });
    expect(result.preamble).toBe('The issue: controller-module-id mismatch.\n\n');
  });

  test('preamble + array body', () => {
    const input = 'Here are the items:\n[{"id":1}]';
    const result = extractJsonValue(input);
    expect(result.json).toEqual([{ id: 1 }]);
    expect(result.preamble).toBe('Here are the items:\n');
  });

  test('(AH1) trailing prose after JSON body → preamble === "" (extractor ran, trailing prose discarded)', () => {
    // AH1: the empty-string preamble marks "extractor ran but JSON was
    // at offset 0; trailing prose discarded" — distinct from the
    // `preamble: undefined` happy path that means "no recovery needed".
    // The distinguishing tri-state is what drives the V1.3.3-4 WARN
    // observability split.
    const result = extractJsonValue('{"a":1}\nHope this helps!');
    expect(result.json).toEqual({ a: 1 });
    expect(result.preamble).toBe('');
  });

  test('preamble AND trailing prose → preamble carries the leading prose, trailing discarded', () => {
    const result = extractJsonValue('Note:\n{"a":1}\n\nbye');
    expect(result.json).toEqual({ a: 1 });
    expect(result.preamble).toBe('Note:\n');
  });

  test('UTF-8 safety: 4-byte emoji in preamble preserves UTF-8 and JSON parses correctly', () => {
    const input = '🎉 deploying:\n{"ok":true}';
    const result = extractJsonValue(input);
    expect(result.json).toEqual({ ok: true });
    expect(result.preamble).toBe('🎉 deploying:\n');
  });
});

describe('extractJsonValue — conservative refusal (irrecoverable shapes)', () => {
  test('(AH2) two balanced JSON blocks → throws JsonExtractionError with the multi-block message', () => {
    // AH2 (resolved): refusal is definite, not auditor-deferred. The
    // specific message string is load-bearing — a future contributor
    // liberalising the rule must intentionally edit this witness.
    expect(() =>
      extractJsonValue('before {"a":1} between {"b":2} after'),
    ).toThrow(JsonExtractionError);
    expect(() =>
      extractJsonValue('before {"a":1} between {"b":2} after'),
    ).toThrow('multiple JSON blocks; refusing to guess');
  });

  test('no JSON value at all → throws JsonExtractionError', () => {
    expect(() => extractJsonValue('just prose, no braces')).toThrow(
      JsonExtractionError,
    );
  });

  test('malformed inner JSON (unbalanced braces) → throws JsonExtractionError', () => {
    expect(() => extractJsonValue('prose {"a":1')).toThrow(JsonExtractionError);
  });
});

describe('extractJsonValue — (AC1) markdown code-fence rejection', () => {
  // AC1: the V1.3.3-2 draft algorithm would have RECOVERED fenced blocks
  // (closing backticks contain no `{`/`[`, so the multi-block check
  // passed). AC1 patches the algorithm with an explicit fence-marker
  // check. These three negative-witness pins make a future fence-handling
  // change an intentional edit, not an algorithmic accident.

  test('```json … ``` (annotated fence) → throws fence-rejection error', () => {
    expect(() => extractJsonValue('```json\n{"a":1}\n```')).toThrow(
      JsonExtractionError,
    );
    expect(() => extractJsonValue('```json\n{"a":1}\n```')).toThrow(
      'fenced code block; refusing to strip fences',
    );
  });

  test('``` … ``` (bare fence, no `json` annotation) → throws fence-rejection error', () => {
    expect(() => extractJsonValue('```\n{"a":1}\n```')).toThrow(
      JsonExtractionError,
    );
    expect(() => extractJsonValue('```\n{"a":1}\n```')).toThrow(
      'fenced code block; refusing to strip fences',
    );
  });

  test('opening fence without closing fence → throws fence-rejection error', () => {
    expect(() => extractJsonValue('```json\n{"a":1}')).toThrow(
      JsonExtractionError,
    );
    expect(() => extractJsonValue('```json\n{"a":1}')).toThrow(
      'fenced code block; refusing to strip fences',
    );
  });
});

describe('JsonExtractionError', () => {
  test('is an Error subclass with the correct name', () => {
    const err = new JsonExtractionError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JsonExtractionError);
    expect(err.name).toBe('JsonExtractionError');
    expect(err.message).toBe('test');
  });

  test('prototype chain restored so instanceof works after rethrow', () => {
    const err = new JsonExtractionError('msg');
    expect(Object.getPrototypeOf(err)).toBe(JsonExtractionError.prototype);
  });
});
