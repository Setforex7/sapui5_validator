/**
 * V1.2-2 (Feature 1, Session V1.2-2) — coverage for the `--per-check-cap`
 * CLI flag wiring in `src/cli.ts`.
 *
 * The flag's `argParser` is the only validation point for the percent value;
 * the orchestrator trusts whatever number it receives. The tests below pull
 * the parser off the registered commander option and exercise it directly,
 * which is faster and more focused than spawning the full CLI just to check
 * argument parsing.
 *
 * Default-value coverage uses `Option.defaultValue` (commander's source of
 * truth for `--per-check-cap`'s built-in default).
 */

import { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { program } from '../../src/cli.js';
import { DEFAULT_PER_CHECK_CAP_PERCENT } from '../../src/budget/cap.js';

function getPerCheckCapParser(): (raw: string) => number {
  const validate = program.commands.find((c: Command) => c.name() === 'validate');
  if (validate === undefined) throw new Error('validate command not registered');
  const opt = validate.options.find((o) => o.long === '--per-check-cap');
  if (opt === undefined) throw new Error('--per-check-cap option not registered');
  // commander stores the argParser as the option's `parseArg` field; cast
  // it to a typed function for the tests.
  const parser = opt.parseArg as (raw: string, prev?: number) => number;
  if (typeof parser !== 'function') throw new Error('--per-check-cap argParser missing');
  return (raw: string) => parser(raw);
}

function getPerCheckCapDefault(): number {
  const validate = program.commands.find((c: Command) => c.name() === 'validate');
  if (validate === undefined) throw new Error('validate command not registered');
  const opt = validate.options.find((o) => o.long === '--per-check-cap');
  if (opt === undefined) throw new Error('--per-check-cap option not registered');
  return opt.defaultValue as number;
}

describe('--per-check-cap argParser (V1.2-2)', () => {
  const parse = getPerCheckCapParser();

  test('default is 35 (the V1.2 plan baseline)', () => {
    expect(getPerCheckCapDefault()).toBe(DEFAULT_PER_CHECK_CAP_PERCENT);
    expect(getPerCheckCapDefault()).toBe(35);
  });

  test('valid value 35 is accepted and parsed as a number', () => {
    expect(parse('35')).toBe(35);
  });

  test('lower bound 1 is accepted', () => {
    expect(parse('1')).toBe(1);
  });

  test('upper bound 100 is accepted', () => {
    expect(parse('100')).toBe(100);
  });

  test('0 is rejected (cap must be at least 1%)', () => {
    expect(() => parse('0')).toThrow(/integer in \[1, 100\]/);
  });

  test('101 is rejected (cap cannot exceed 100%)', () => {
    expect(() => parse('101')).toThrow(/integer in \[1, 100\]/);
  });

  test('negative values are rejected', () => {
    expect(() => parse('-1')).toThrow(/integer in \[1, 100\]/);
  });

  test('non-numeric input is rejected', () => {
    expect(() => parse('thirty-five')).toThrow(/integer in \[1, 100\]/);
  });

  test('decimal input is rejected (must be an integer percent)', () => {
    expect(() => parse('35.5')).toThrow(/integer in \[1, 100\]/);
  });

  test('empty string is rejected', () => {
    expect(() => parse('')).toThrow(/integer in \[1, 100\]/);
  });
});
