/**
 * V1.6 / V1.9.7 — coverage for the `--concurrency` CLI flag wiring in
 * `src/cli.ts`. The flag shipped generate-only (V1.6, lane-safe verify);
 * V1.9.7 (THR-2) additionally registers it on `validate` for the findings-only
 * batch phase (no verify lane there, so no lane restriction).
 *
 * The flag's `argParser` is the only validation point for the degree; the
 * orchestrator trusts whatever number it receives (generate additionally gates
 * it to lane-safe discovery modes). Like `cli-per-check-cap.test.ts`, this pulls
 * the parser and default off the registered commander option rather than
 * spawning the CLI.
 */

import { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { program } from '../../src/cli.js';

function commandNamed(name: string): Command {
  const cmd = program.commands.find((c: Command) => c.name() === name);
  if (cmd === undefined) throw new Error(`${name} command not registered`);
  return cmd;
}

function generateCommand(): Command {
  return commandNamed('generate');
}

function concurrencyParserOf(command: Command): (raw: string) => number {
  const opt = command.options.find((o) => o.long === '--concurrency');
  if (opt === undefined) throw new Error('--concurrency option not registered');
  const parser = opt.parseArg as (raw: string, prev?: number) => number;
  if (typeof parser !== 'function') throw new Error('--concurrency argParser missing');
  return (raw: string) => parser(raw);
}

function concurrencyDefaultOf(command: Command): number {
  const opt = command.options.find((o) => o.long === '--concurrency');
  if (opt === undefined) throw new Error('--concurrency option not registered');
  return opt.defaultValue as number;
}

describe('--concurrency argParser (V1.6)', () => {
  const parse = concurrencyParserOf(generateCommand());

  test('default is 2 (V1.9.7 THR-1) — --concurrency 1 restores the SPEC §2.15 sequential contract', () => {
    expect(concurrencyDefaultOf(generateCommand())).toBe(2);
  });

  test('1 is accepted (explicit sequential)', () => {
    expect(parse('1')).toBe(1);
  });

  test('a higher degree is accepted and parsed as a number', () => {
    expect(parse('2')).toBe(2);
    expect(parse('8')).toBe(8);
  });

  test('0 is rejected (degree must be at least 1)', () => {
    expect(() => parse('0')).toThrow(/integer >= 1/);
  });

  test('negative values are rejected', () => {
    expect(() => parse('-2')).toThrow(/integer >= 1/);
  });

  test('decimal input is rejected (degree is a whole number of workers)', () => {
    expect(() => parse('2.5')).toThrow(/integer >= 1/);
  });

  test('non-numeric input is rejected', () => {
    expect(() => parse('two')).toThrow(/integer >= 1/);
  });

  test('empty string is rejected', () => {
    expect(() => parse('')).toThrow(/integer >= 1/);
  });

  test('the flag is registered on BOTH generate and validate (V1.9.7 THR-2 scope)', () => {
    // V1.6 shipped `--concurrency` generate-only ("validate has no concurrency
    // dial"); V1.9.7 (THR-2) deliberately reverses that, adding it to validate
    // for the findings-only batch phase. Both commands must carry it now.
    expect(generateCommand().options.some((o) => o.long === '--concurrency')).toBe(true);
    expect(commandNamed('validate').options.some((o) => o.long === '--concurrency')).toBe(true);
  });

  test("validate's --concurrency mirrors generate: default 2 and the same integer>=1 validation", () => {
    const validate = commandNamed('validate');
    expect(concurrencyDefaultOf(validate)).toBe(2);
    const parseV = concurrencyParserOf(validate);
    expect(parseV('1')).toBe(1);
    expect(parseV('4')).toBe(4);
    expect(() => parseV('0')).toThrow(/integer >= 1/);
    expect(() => parseV('-1')).toThrow(/integer >= 1/);
    expect(() => parseV('2.5')).toThrow(/integer >= 1/);
    expect(() => parseV('two')).toThrow(/integer >= 1/);
    expect(() => parseV('')).toThrow(/integer >= 1/);
  });
});
