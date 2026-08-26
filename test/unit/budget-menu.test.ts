/**
 * V1.2-1 (Feature 1, Session V1.2-1) — coverage for the interactive
 * `promptCallLimitChoice` menu used by `validate` to negotiate the LLM call
 * budget with the user before any LLM call fires.
 *
 * Every test wires a paired `Readable` (queued stdin lines) + memory
 * `Writable` for stdout/stderr through the `MenuIo` injection point so the
 * suite stays fully in-process and deterministic.
 */

import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import {
  CUSTOM_LIMIT_MAX,
  promptCallLimitChoice,
  promptModelChoice,
  type MenuIo,
} from '../../src/budget/menu.js';

interface Harness {
  readonly io: MenuIo;
  readonly stdout: string[];
  readonly stderr: string[];
}

function memoryWritable(sink: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk, _enc, cb) {
      sink.push(chunk.toString('utf8'));
      cb();
    },
  });
}

/**
 * Build a MenuIo that feeds the queued lines on stdin (each entry adds one
 * `\n`-terminated line). `isTty` defaults to true so the menu actually runs;
 * pass `isTty: false` to exercise the non-interactive short-circuit.
 */
function harness(
  lines: readonly string[],
  opts: { readonly isTty?: boolean } = {},
): Harness {
  const stdin = new PassThrough();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: MenuIo = {
    stdin,
    stdout: memoryWritable(stdout),
    stderr: memoryWritable(stderr),
    isTty: opts.isTty ?? true,
  };
  // Push each line then end the stream so the readline closes on its own
  // after the last queued response is consumed — this prevents tests from
  // hanging indefinitely when the menu requests more input than supplied.
  for (const line of lines) stdin.write(`${line}\n`);
  stdin.end();
  return { io, stdout, stderr };
}

const ESTIMATE_50_120 = { minimum: 50, recommended: 120 };

describe('promptCallLimitChoice — main menu', () => {
  test('option 1 (continue) returns continue with no newLimit', async () => {
    const h = harness(['1']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'continue' });
  });

  test('option 2 (accept) returns accept with newLimit = recommended', async () => {
    const h = harness(['2']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'accept', newLimit: 120 });
  });

  test('option 4 (cancel) returns cancel with no newLimit', async () => {
    const h = harness(['4']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'cancel' });
  });

  test('invalid main-menu input re-prompts, falls back to cancel after 3 attempts', async () => {
    const h = harness(['5', 'abc', '9']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'cancel' });
    const stderr = h.stderr.join('');
    expect(stderr).toMatch(/Invalid choice "5"/);
    expect(stderr).toMatch(/Invalid choice "abc"/);
    expect(stderr).toMatch(/Invalid choice "9"/);
    expect(stderr).toMatch(/Too many invalid responses/);
  });

  test('non-TTY environment short-circuits to continue', async () => {
    const h = harness([], { isTty: false });
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'continue' });
    expect(h.stderr.join('')).toMatch(/non-interactive stdin/i);
    // No prompt should have been printed; the menu was suppressed.
    expect(h.stdout.join('')).toBe('');
  });

  test('header line uses totalFiles + checkCategories when present in estimate', async () => {
    const h = harness(['1']);
    await promptCallLimitChoice(
      50,
      120,
      { minimum: 50, recommended: 120, totalFiles: 14, checkCategories: 7 },
      h.io,
    );
    expect(h.stdout.join('')).toMatch(
      /Detected 14 files in scope across 7 check categories\./,
    );
    expect(h.stdout.join('')).toMatch(
      /Estimated 50-120 LLM calls needed for complete analysis\./,
    );
  });
});

describe('promptCallLimitChoice — option 3 (custom limit)', () => {
  test('valid custom input returns custom with the user value as newLimit', async () => {
    const h = harness(['3', '200']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'custom', newLimit: 200 });
  });

  test('input below estimate.minimum is accepted but emits a warning', async () => {
    const h = harness(['3', '10']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'custom', newLimit: 10 });
    expect(h.stderr.join('')).toMatch(
      /warning: 10 calls is below the estimated minimum of 50/,
    );
  });

  test('input above the hard cap is rejected, then a valid retry succeeds', async () => {
    const h = harness(['3', '30000', '500']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'custom', newLimit: 500 });
    expect(h.stderr.join('')).toMatch(
      new RegExp(`30000 exceeds the hard cap of ${CUSTOM_LIMIT_MAX}`),
    );
  });

  test('non-numeric and negative input re-prompts then falls back to cancel after 3 attempts', async () => {
    const h = harness(['3', 'abc', '-5', '1.5']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'cancel' });
    const stderr = h.stderr.join('');
    expect(stderr).toMatch(/"abc" is not a positive integer/);
    expect(stderr).toMatch(/"-5" is not a positive integer/);
    expect(stderr).toMatch(/"1\.5" is not a positive integer/);
    expect(stderr).toMatch(/Too many invalid custom-limit responses/);
  });

  test('zero is rejected (not a positive integer)', async () => {
    const h = harness(['3', '0', '0', '0']);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'cancel' });
    expect(h.stderr.join('')).toMatch(/"0" is not a positive integer/);
  });

  test('exactly the hard cap is accepted', async () => {
    const h = harness(['3', String(CUSTOM_LIMIT_MAX)]);
    const choice = await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(choice).toEqual({ action: 'custom', newLimit: CUSTOM_LIMIT_MAX });
  });
});

describe('promptCallLimitChoice — output formatting (SPEC verbatim)', () => {
  test('default current limit appends "(default)" suffix', async () => {
    const h = harness(['1']);
    await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    expect(h.stdout.join('')).toMatch(/Current call limit: 50 \(default\)/);
  });

  test('non-default current limit omits "(default)" suffix', async () => {
    const h = harness(['1']);
    await promptCallLimitChoice(75, 120, ESTIMATE_50_120, h.io);
    const stdout = h.stdout.join('');
    expect(stdout).toMatch(/Current call limit: 75/);
    expect(stdout).not.toMatch(/\(default\)/);
  });

  test('menu prints all four options in order', async () => {
    const h = harness(['1']);
    await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io);
    const stdout = h.stdout.join('');
    expect(stdout).toMatch(/\[1\] Continue with current limit \(50\)/);
    expect(stdout).toMatch(/\[2\] Increase to recommended \(120\)/);
    expect(stdout).toMatch(/\[3\] Enter custom limit/);
    expect(stdout).toMatch(/\[4\] Cancel/);
  });

  test('V1.9.7 (THR-1): an effective concurrency > 1 is stated as one menu line', async () => {
    const h = harness(['1']);
    // 6th positional arg = effectiveConcurrency; 5th (headerOverride) left unset.
    await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h.io, undefined, 2);
    const stdout = h.stdout.join('');
    expect(stdout).toMatch(/Dispatching up to 2 LLM calls at once/);
    expect(stdout).toMatch(/--concurrency 2/);
  });

  test('V1.9.7 (THR-1): a sequential run (K=1 or unset) prints NO concurrency line', async () => {
    const h1 = harness(['1']);
    await promptCallLimitChoice(50, 120, ESTIMATE_50_120, h1.io, undefined, 1);
    expect(h1.stdout.join('')).not.toMatch(/Dispatching up to/);
    const hUnset = harness(['1']);
    await promptCallLimitChoice(50, 120, ESTIMATE_50_120, hUnset.io);
    expect(hUnset.stdout.join('')).not.toMatch(/Dispatching up to/);
  });
});

describe('promptModelChoice (V1.9.4 PERF-17) — opt-in per-run model picker', () => {
  test('non-TTY short-circuits to the default model, silently (no prompt)', async () => {
    // Fail-on-revert guard: a non-interactive stdin must NEVER block CI or
    // silently downgrade — it keeps the default (no `--model`). Reverting the
    // `if (!io.isTty) return {}` guard would render the menu and hang on the
    // empty stdin, turning this assertion red.
    const h = harness([], { isTty: false });
    const choice = await promptModelChoice(h.io, { isTypeScript: false });
    expect(choice).toEqual({});
    expect(h.stdout.join('')).toBe('');
    expect(h.stderr.join('')).toBe('');
  });

  test('option [1] keeps the default model (returns {})', async () => {
    const h = harness(['1']);
    const choice = await promptModelChoice(h.io, { isTypeScript: false });
    expect(choice).toEqual({});
  });

  test('option [2] + a model id returns that id verbatim (free-form)', async () => {
    const h = harness(['2', 'some-cheaper-model']);
    const choice = await promptModelChoice(h.io, { isTypeScript: false });
    expect(choice).toEqual({ model: 'some-cheaper-model' });
  });

  test('option [2] + a blank id keeps the default (returns {})', async () => {
    const h = harness(['2', '   ']);
    const choice = await promptModelChoice(h.io, { isTypeScript: false });
    expect(choice).toEqual({});
  });

  test('TypeScript project renders the static-only downgrade WARNING', async () => {
    // Fail-on-revert guard (R5): a cheaper model on the TS static-only lane can
    // emit a shallow-but-compiling test the static gate cannot catch, so the
    // downgrade must never be silent. Reverting the `if (isTypeScript)` warning
    // block turns this red.
    const h = harness(['1']);
    await promptModelChoice(h.io, { isTypeScript: true });
    const stdout = h.stdout.join('');
    expect(stdout).toMatch(/WARNING/);
    expect(stdout).toMatch(/TypeScript/);
    expect(stdout).toMatch(/STATIC/i);
    expect(stdout).toMatch(/shallow/i);
  });

  test('a JavaScript project does NOT render the TS downgrade warning', async () => {
    const h = harness(['1']);
    await promptModelChoice(h.io, { isTypeScript: false });
    const stdout = h.stdout.join('');
    expect(stdout).not.toMatch(/WARNING/);
    // ...but it DOES offer the choice (so this is not a vacuous assertion).
    expect(stdout).toMatch(/\[1\] Keep your Claude Code model/);
    expect(stdout).toMatch(/\[2\] Use a cheaper model/);
  });

  test('the render names NO model id (decision §11.8(a): free-form, zero model names)', async () => {
    const h = harness(['1']);
    await promptModelChoice(h.io, { isTypeScript: true });
    const stdout = h.stdout.join('');
    // The menu must not leak a model alias (opus/sonnet/haiku/claude-…) — the
    // whole UX is free-form so `src/` stays model-name-free.
    expect(stdout).not.toMatch(/\b(opus|sonnet|haiku)\b/i);
    expect(stdout).not.toMatch(/claude-/i);
  });

  test('invalid menu input re-prompts, then keeps the default after 3 attempts', async () => {
    const h = harness(['9', 'x', '0']);
    const choice = await promptModelChoice(h.io, { isTypeScript: false });
    expect(choice).toEqual({});
    const stderr = h.stderr.join('');
    expect(stderr).toMatch(/Invalid choice "9"/);
    expect(stderr).toMatch(/keeping the default model/i);
  });
});
