/**
 * V1.5 #A5 — `parseJsonWithBom` is the shared tolerant read used by every
 * manifest.json parse site. It must accept BOM-prefixed (but valid) JSON and
 * otherwise behave exactly like JSON.parse (throw on genuinely malformed input).
 */
import { describe, expect, test } from 'vitest';
import { parseJsonWithBom } from '../../src/util/json-read.js';

describe('parseJsonWithBom', () => {
  test('parses plain JSON identically to JSON.parse', () => {
    expect(parseJsonWithBom('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  test('strips a single leading UTF-8 BOM (U+FEFF) before parsing', () => {
    const withBom = '﻿{"sap.app":{"type":"application"}}';
    expect(parseJsonWithBom(withBom)).toEqual({ 'sap.app': { type: 'application' } });
  });

  test('throws SyntaxError on genuinely malformed JSON, with or without a BOM', () => {
    expect(() => parseJsonWithBom('{not json}')).toThrow(SyntaxError);
    expect(() => parseJsonWithBom('﻿{not json}')).toThrow(SyntaxError);
  });

  test('does not strip a U+FEFF that is not the very first character', () => {
    // A FEFF inside a string value is data, not a leading BOM — it survives.
    expect(parseJsonWithBom('"a﻿b"')).toBe('a﻿b');
  });
});
