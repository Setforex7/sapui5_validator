/**
 * V1.5 #F1/#F4 — `findMatchingDelimiter` is the shared bracket balance-scanner
 * that replaces the non-greedy `[\s\S]*?]` truncation in the registration and
 * karma-files array parsers. It must balance nested pairs and skip delimiters
 * inside string literals.
 */
import { describe, expect, test } from 'vitest';
import { findMatchingDelimiter } from '../../src/util/balance-scan.js';

describe('findMatchingDelimiter', () => {
  test('matches a simple bracket pair', () => {
    const s = '[a, b]';
    expect(findMatchingDelimiter(s, 0, '[', ']')).toBe(s.length - 1);
  });

  test('balances nested same-type delimiters', () => {
    const s = '[a, [b, [c]], d]';
    expect(findMatchingDelimiter(s, 0, '[', ']')).toBe(s.length - 1);
  });

  test('a closing bracket inside a string literal does not end the array', () => {
    const s = "['has ] bracket', 'ok']";
    expect(findMatchingDelimiter(s, 0, '[', ']')).toBe(s.length - 1);
  });

  test('a backslash-escaped quote does not prematurely end a string', () => {
    const s = "['it\\'s ]', 'b']"; // first entry is the string  it's ]
    expect(findMatchingDelimiter(s, 0, '[', ']')).toBe(s.length - 1);
  });

  test('matches a brace pair, ignoring unrelated bracket types', () => {
    const s = '{ a: [1, 2], b: 3 }';
    expect(findMatchingDelimiter(s, 0, '{', '}')).toBe(s.length - 1);
  });

  test('scans from the given open index, not position 0', () => {
    const s = 'files: [a, b]';
    const open = s.indexOf('[');
    expect(findMatchingDelimiter(s, open, '[', ']')).toBe(s.length - 1);
  });

  test('returns null when the bracket is never closed', () => {
    expect(findMatchingDelimiter('[a, b', 0, '[', ']')).toBeNull();
  });
});
