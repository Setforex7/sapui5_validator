import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  BinaryRunner,
  ClaudeApiError,
  ClaudeEnvelopeContractError,
  ClaudeProcessKilledError,
  DEFAULT_REFORMAT_SUFFIX,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
  buildClaudeExecArgs,
} from '../../src/claude/binary-runner.js';
import { ALLOWED_TOOLS, buildClaudeArgs } from '../../src/claude/runner.js';
import { isRateLimitedApiError } from '../../src/checks/_shared.js';
import { RATE_LIMIT_SIGNAL_RE } from '../../src/claude/rate-limit-signal.js';
import { RATE_LIMIT_SIGNAL_RE as RATE_LIMIT_SIGNAL_RE_REEXPORT } from '../../src/checks/_shared.js';
import type { ExecResult } from '../../src/util/exec.js';

interface FakeExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  // TR-1 (V1.9.6): the prompt now arrives via the child's stdin, forwarded as
  // execa's `input`. Captured so the stdin-transport witnesses can assert the
  // prompt reached the runner intact and never entered argv.
  readonly input?: string;
}

function makeFakeExec(responses: readonly Partial<ExecResult>[]): {
  exec: (
    file: string,
    args?: readonly string[],
    opts?: { cwd?: string; input?: string },
  ) => Promise<ExecResult>;
  calls: FakeExecCall[];
} {
  const calls: FakeExecCall[] = [];
  let i = 0;
  const exec = async (
    file: string,
    args: readonly string[] = [],
    opts: { cwd?: string; input?: string } = {},
  ): Promise<ExecResult> => {
    calls.push({
      file,
      args: [...args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    const r = responses[i] ?? {};
    i += 1;
    return {
      ok: r.ok ?? true,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      exitCode: r.exitCode ?? 0,
      durationMs: r.durationMs ?? 1,
    };
  };
  return { exec, calls };
}

const ENVELOPE_FIXTURES = join(process.cwd(), 'test', 'fixtures', 'llm-envelopes');

/**
 * `claude -p --output-format json` emits a structured envelope; the model's
 * actual response is the `result` STRING inside it. These helpers build the
 * envelope shape `BinaryRunner` now unwraps (V1.1-DIAGNOSIS.md §"Bug 3"), so
 * the exec stub feeds what the real binary emits — not the inner payload.
 */
function successEnvelope(innerResult: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: innerResult,
    session_id: 'sess-test',
    total_cost_usd: 0,
    uuid: 'uuid-test',
  });
}

function errorEnvelope(overrides: {
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  result?: string;
}): string {
  return JSON.stringify({
    type: 'result',
    subtype: overrides.subtype ?? 'error',
    is_error: overrides.is_error ?? true,
    api_error_status: overrides.api_error_status ?? null,
    result: overrides.result ?? 'API Error: something failed',
    session_id: 'sess-test',
    uuid: 'uuid-test',
  });
}

let errorDir: string;

beforeEach(() => {
  errorDir = mkdtempSync(join(tmpdir(), 'sapui5-validator-llm-err-'));
});

afterEach(() => {
  rmSync(errorDir, { recursive: true, force: true });
});

describe('BinaryRunner', () => {
  test('happy path: unwraps the envelope and returns the inner payload', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{"hello":"world"}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'call-1',
    });
    const args = buildClaudeArgs({ prompt: 'do thing', cwd: '/work' });
    const result = await runner.run(args);

    expect(result.ok).toBe(true);
    // `json` / `raw` are the model's INNER response, not the transport envelope.
    expect(result.json).toEqual({ hello: 'world' });
    expect(result.raw).toBe('{"hello":"world"}');
    expect(result.exitCode).toBe(0);
    expect(result.callId).toBe('call-1');
    // V1.9.4 PERF-1 — the additive observability fields surface from the
    // envelope: `successEnvelope` carries session_id + total_cost_usd (0) but
    // no usage block / num_turns, so those two stay absent.
    expect(result.sessionId).toBe('sess-test');
    expect(result.totalCostUsd).toBe(0);
    expect(result.usage).toBeUndefined();
    expect(result.numTurns).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('claude');
    // TR-1 (V1.9.6): argv is flags-only — the prompt is NOT a positional. It
    // travels via stdin (asserted next). `-p` with no positional makes `claude`
    // read the prompt from fd 0.
    expect(calls[0]?.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
    ]);
    expect(calls[0]?.input).toBe('do thing');
    expect(calls[0]?.cwd).toBe('/work');
  });

  test('PERF-1: surfaces envelope usage/cost/session/turns on ClaudeRunResult (all four token fields)', async () => {
    // Mirrors the captured Max envelope (test/fixtures/llm-envelopes/
    // envelope-success-simple.json) but with a JSON-valued `result` so the
    // success path is taken. interpretEnvelope must surface every usage
    // sub-field: §6 — total input = cache_read + cache_creation + input, so a
    // mapping that drops any one under-reports spend. Fail-on-revert guard for
    // PERF-1: reverting the finalize/interpretEnvelope thread-through leaves
    // these fields `undefined` and every assertion below goes red.
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      num_turns: 3,
      result: '{"ok":true}',
      session_id: '945e380f-a63b-45a7-b5c8-ac56f053b071',
      total_cost_usd: 0.07007925,
      usage: {
        input_tokens: 6,
        output_tokens: 20,
        cache_read_input_tokens: 19086,
        cache_creation_input_tokens: 9601,
      },
    });
    const { exec } = makeFakeExec([{ ok: true, exitCode: 0, stdout: envelope }]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'perf1',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));

    // The inner payload still unwraps unchanged (observability is additive).
    expect(result.json).toEqual({ ok: true });
    // All four token sub-fields surface distinctly.
    expect(result.usage).toEqual({
      inputTokens: 6,
      outputTokens: 20,
      cacheReadTokens: 19086,
      cacheCreationTokens: 9601,
    });
    expect(result.totalCostUsd).toBeCloseTo(0.07007925, 8);
    expect(result.numTurns).toBe(3);
    expect(result.sessionId).toBe('945e380f-a63b-45a7-b5c8-ac56f053b071');
  });

  test('PERF-1: omits usage/cost fields when the envelope carries none (additive, no $null)', async () => {
    // A bare envelope (no usage / total_cost_usd / session_id / num_turns)
    // must leave every new field absent — the presence-gated CLI line and the
    // additive report depend on `undefined`, never a zero placeholder.
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      result: '{"ok":true}',
    });
    const { exec } = makeFakeExec([{ ok: true, exitCode: 0, stdout: envelope }]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'bare',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(result.json).toEqual({ ok: true });
    expect(result.usage).toBeUndefined();
    expect(result.totalCostUsd).toBeUndefined();
    expect(result.numTurns).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
  });

  test('B1 residual-argv guard: an oversized flags-only argv (huge --system-prompt) is refused pre-spawn — the stdin prompt does not count toward it', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'argv-call',
    });
    // TR-1 (V1.9.6): the prompt travels via stdin, so it can be arbitrarily large
    // without inflating argv. The guard now measures ONLY the residual flags-only
    // argv; the one realistic way to overflow it is an oversized `--system-prompt`.
    // A large prompt carried ALONGSIDE it must NOT contribute to the overflow — so
    // this witness pairs a 40 KB stdin prompt with the oversized system prompt and
    // still asserts the guard fires on the flags alone.
    const hugeSystemPrompt = 'x'.repeat(40_000);
    const largePromptOnStdin = 'p'.repeat(40_000);
    await expect(
      runner.run(
        buildClaudeArgs({
          prompt: largePromptOnStdin,
          cwd: '/work',
          systemPrompt: hugeSystemPrompt,
        }),
      ),
    ).rejects.toBeInstanceOf(ClaudeProcessKilledError);
    // The guard fires PRE-spawn — execImpl is never invoked.
    expect(calls).toHaveLength(0);
    // The persisted dump names the accurate cause (the process-argument limit).
    const dump = readFileSync(join(errorDir, 'llm-error-argv-call.txt'), 'utf8');
    expect(dump).toMatch(/process-argument limit/i);
  });

  test('TR-1 stdin transport: a >64 KiB multi-byte prompt reaches the runner via stdin, byte-intact, and never enters argv', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'stdin-call',
    });
    // >64 KiB — over 2× the Windows CreateProcess argv ceiling the OLD argv
    // transport could not carry (the exact files the V1.9.5 baseline had to skip:
    // Shop.controller.js 13.7 KB, CartService.js 9.2 KB, Shop.controller.ts
    // 14.3 KB). Multi-byte on purpose: BMP CJK (3-byte UTF-8) AND an astral
    // 🔬 U+1F52C (4-byte / surrogate pair) — the COR-12 surface. A tail sentinel
    // proves the bytes past the old ceiling arrived intact, not truncated.
    const body = '日本語'.repeat(25_000); // 75k UTF-16 code units, ~225 KB UTF-8
    const prompt = `${body}\n私🔬_STDIN_TAIL_SENTINEL_42_END`;
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(64 * 1024);

    const result = await runner.run(buildClaudeArgs({ prompt, cwd: '/w' }));

    // The call went through — the oversized prompt was NOT refused (contrast the
    // residual-argv guard above, which fires only on oversized FLAGS).
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // The prompt travelled on stdin, byte-for-byte identical...
    expect(calls[0]?.input).toBe(prompt);
    // ...and NEVER appears in argv. This is the fail-on-revert guard for the whole
    // transport swap: reverting to argv transport puts `prompt` back at args[1]
    // (blowing the OS ceiling) and both of these assertions go red.
    expect(calls[0]?.args).not.toContain(prompt);
    expect(calls[0]?.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
    ]);
  });

  test('unwraps the empirical envelope fixture to its inner findings payload', async () => {
    const fixture = readFileSync(
      join(ENVELOPE_FIXTURES, 'envelope-success-findings.json'),
      'utf8',
    );
    const { exec } = makeFakeExec([{ ok: true, exitCode: 0, stdout: fixture }]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(result.raw).toBe('{"findings":[]}');
    expect(result.json).toEqual({ findings: [] });
    expect(result.ok).toBe(true);
  });

  test('passes systemPrompt as --system-prompt when set', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c',
    });
    await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w', systemPrompt: 'be terse' }));
    expect(calls[0]?.args).toContain('--system-prompt');
    expect(calls[0]?.args).toContain('be terse');
  });

  test('reformat retry: unparseable first attempt, valid envelope second', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: 'not json' },
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(result.json).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    // TR-1 (V1.9.6): the second call must append the reformat suffix — carried on
    // stdin now, not at argv[1]. (Regression guard: reverting to argv transport
    // puts the reformatted prompt back at args[1] and this goes red.)
    expect(calls[1]?.input).toBe('p' + DEFAULT_REFORMAT_SUFFIX);
  });

  test('reformat retry: well-formed envelope but inner result is prose, valid second', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('here is some prose, not JSON') },
      { ok: true, exitCode: 0, stdout: successEnvelope('{"recovered":1}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(result.json).toEqual({ recovered: 1 });
    expect(calls).toHaveLength(2);
  });

  test('double malformed: persists llm-error file and throws MalformedLlmOutputError', async () => {
    const { exec } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: 'bad', stderr: 'err1' },
      { ok: true, exitCode: 0, stdout: 'still bad', stderr: 'err2' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'doomed',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedLlmOutputError);
    if (caught instanceof MalformedLlmOutputError) {
      expect(caught.callId).toBe('doomed');
      expect(caught.errorFilePath).toBe(join(errorDir, 'llm-error-doomed.txt'));
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      expect(dump).toContain('Call ID: doomed');
      expect(dump).toContain('--- Attempt 1 ---');
      expect(dump).toContain('--- Attempt 2 (reformat retry) ---');
      expect(dump).toContain('bad');
      expect(dump).toContain('still bad');
      expect(dump).toContain('err1');
      expect(dump).toContain('err2');
    }
  });

  test('malformed envelope (outer JSON unparseable) is MalformedLlmOutputError, distinct from a process kill', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: '<<not an envelope>>', stderr: '' },
      { ok: true, exitCode: 0, stdout: '<<still not an envelope>>', stderr: '' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedLlmOutputError);
    expect(caught).not.toBeInstanceOf(ClaudeProcessKilledError);
    // Non-empty stdout with exit 0 → the reformat retry still fires.
    expect(calls).toHaveLength(2);
  });

  // TR-2 (V1.9.6) — envelope-contract mismatch (valid JSON, WRONG shape) is a
  // CLI-drift signal, distinct from malformed model output (above) and from a
  // non-JSON body (which stays retryable). This pair is the fail-on-revert guard.
  test('TR-2: contract-mismatch (valid JSON, wrong envelope shape) throws ClaudeEnvelopeContractError WITHOUT the reformat retry', async () => {
    const { exec, calls } = makeFakeExec([
      // Valid JSON, but NOT the claude envelope contract (no type/is_error/result).
      { ok: true, exitCode: 0, stdout: JSON.stringify({ unexpected: 'shape', foo: 1 }) },
      // A second response is queued but must NEVER be consumed — the reformat
      // retry does not fire on CLI-contract drift.
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'drift',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    // Fail-on-revert: a wrong-SHAPE envelope must classify as contract-mismatch,
    // NOT malformed-payload, and must NOT spend the reformat retry. If the Case-2
    // split is reverted (envelope-schema mismatch → retryable), the runner
    // re-prompts → calls.length === 2 and the class is MalformedLlmOutputError,
    // so BOTH assertions below flip.
    expect(caught).toBeInstanceOf(ClaudeEnvelopeContractError);
    expect(caught).not.toBeInstanceOf(MalformedLlmOutputError);
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeEnvelopeContractError) {
      expect(caught.callId).toBe('drift');
      expect(caught.errorFilePath).toBe(join(errorDir, 'llm-error-drift.txt'));
      expect(caught.detail).toContain('unexpected claude envelope shape');
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      expect(dump).toContain('ENVELOPE CONTRACT MISMATCH');
      expect(dump).toContain('Call ID: drift');
    }
  });

  test('TR-2: a contract-mismatch surfacing only on the retry attempt is still ClaudeEnvelopeContractError', async () => {
    const { exec, calls } = makeFakeExec([
      // First body is non-JSON → retryable → the reformat retry DOES fire.
      { ok: true, exitCode: 0, stdout: 'not json at all' },
      // The retry returns a wrong-SHAPE envelope → contract-mismatch (not malformed).
      { ok: true, exitCode: 0, stdout: JSON.stringify({ still: 'wrong shape' }) },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c2',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeEnvelopeContractError);
    expect(caught).not.toBeInstanceOf(MalformedLlmOutputError);
    // The retry fired (first body was genuinely retryable), THEN the second body
    // was classified as contract drift.
    expect(calls).toHaveLength(2);
  });

  test('non-zero exit but valid success envelope: ok=false, result returned, no throw', async () => {
    const { exec } = makeFakeExec([
      {
        ok: false,
        exitCode: 2,
        stdout: successEnvelope('{"reason":"quota"}'),
        stderr: 'rate limit',
      },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'c',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.json).toEqual({ reason: 'quota' });
    // stderr is preserved so isRateLimitedResult / withRateLimitBackoff still
    // have their signal on a returned (non-throwing) result.
    expect(result.stderr).toBe('rate limit');
  });

  // --- Bug 2 / Bug 6: process kill distinguished from malformed output ---

  test('process kill: exitCode -1 + empty stdout throws ClaudeProcessKilledError, no reformat retry', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: false, exitCode: -1, stdout: '', stderr: '' },
      // A second response is present but must NOT be consumed.
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'killed-1',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeProcessKilledError);
    // Bug 6: the reformat retry must not fire — exactly one exec call.
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeProcessKilledError) {
      expect(caught.callId).toBe('killed-1');
      expect(caught.exitCode).toBe(-1);
      expect(caught.stderr).toBe('');
      expect(caught.errorFilePath).toBe(join(errorDir, 'llm-error-killed-1.txt'));
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      expect(dump).toContain('PROCESS KILLED');
      expect(dump).not.toContain('reformat retry)'); // not the malformed-output dump
      expect(dump).toContain('exitCode: -1');
    }
  });

  test('process kill: non-zero exit + empty stdout throws ClaudeProcessKilledError', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: false, exitCode: 137, stdout: '', stderr: 'Killed' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'killed-2',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeProcessKilledError);
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeProcessKilledError) {
      expect(caught.exitCode).toBe(137);
      expect(caught.stderr).toBe('Killed');
    }
  });

  // --- Bug 3: well-formed envelope reporting a non-success API outcome ---

  test('is_error envelope throws ClaudeApiError with no reformat retry', async () => {
    const { exec, calls } = makeFakeExec([
      {
        ok: true,
        exitCode: 0,
        stdout: errorEnvelope({
          subtype: 'error',
          is_error: true,
          api_error_status: '429',
          result: 'API Error: 429 Too Many Requests',
        }),
      },
      // Present but must NOT be consumed — an API error is not retryable.
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'api-1',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeApiError) {
      expect(caught.callId).toBe('api-1');
      expect(caught.subtype).toBe('error');
      expect(caught.isError).toBe(true);
      expect(caught.apiErrorStatus).toBe('429');
      expect(caught.result).toContain('429 Too Many Requests');
      expect(caught.errorFilePath).toBe(join(errorDir, 'llm-error-api-1.txt'));
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      expect(dump).toContain('CLAUDE API ERROR');
      expect(dump).toContain('api_error_status: 429');
      expect(dump).toContain('429 Too Many Requests');
      expect(dump).not.toContain('PROCESS KILLED');
    }
  });

  test('non-success subtype with is_error:false also throws ClaudeApiError', async () => {
    const { exec, calls } = makeFakeExec([
      {
        ok: true,
        exitCode: 0,
        stdout: errorEnvelope({
          subtype: 'error_max_turns',
          is_error: false,
          api_error_status: null,
          result: 'Reached the maximum number of turns.',
        }),
      },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'api-2',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeApiError) {
      expect(caught.subtype).toBe('error_max_turns');
      expect(caught.isError).toBe(false);
      expect(caught.apiErrorStatus).toBeNull();
    }
  });

  // --- V1.9.6 real-gate fix: a NUMERIC api_error_status is a genuine API error,
  // not envelope-contract drift ---

  test('numeric api_error_status (real 400 "prompt too long") → ClaudeApiError, NOT a fatal ClaudeEnvelopeContractError', async () => {
    // Byte-faithful to the envelope the real claude CLI (2.1.200) returned when
    // the V1.9.6 stdin transport let an oversized prompt reach the API: a
    // well-formed `is_error:true` body whose `api_error_status` is the NUMBER
    // 400 (the raw HTTP status), with `subtype:"success"`. Before the fix, the
    // envelope schema (api_error_status: string|null) rejected the number, so
    // this real per-call API error was misclassified as `contract-mismatch` and
    // FATALLY aborted the whole run with a misleading "update your CLI" message.
    // Fail-on-revert: drop `z.number()` from the union (or the String() normalise)
    // and this envelope throws ClaudeEnvelopeContractError again — red here.
    const numericErrorEnvelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 400,
      result:
        'Prompt is too long · the request is ~1052074 tokens (limit 1000000). ' +
        'Reduce attached files/tools or start with less context.',
      session_id: 'sess-test',
      total_cost_usd: 0,
      uuid: 'uuid-test',
    });
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: numericErrorEnvelope },
      // Present but must NOT be consumed — an API error is not retryable.
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'api-num-400',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(caught).not.toBeInstanceOf(ClaudeEnvelopeContractError);
    expect(calls).toHaveLength(1); // no reformat retry burned on an API error
    if (caught instanceof ClaudeApiError) {
      expect(caught.subtype).toBe('success');
      expect(caught.isError).toBe(true);
      // The numeric HTTP status is normalised to its decimal string.
      expect(caught.apiErrorStatus).toBe('400');
      expect(caught.result).toContain('Prompt is too long');
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      expect(dump).toContain('CLAUDE API ERROR');
      expect(dump).toContain('api_error_status: 400');
      expect(dump).not.toContain('CONTRACT MISMATCH');
    }
  });

  test('numeric api_error_status 429 normalises to "429" so the rate-limit fast-path still matches', async () => {
    // An enveloped 429 with a NUMERIC status must still normalise to '429' so
    // isRateLimitedApiError (=== '429') routes it onto the backoff schedule —
    // the D2 (V1.9.3) guarantee, preserved (and now reached via the clean
    // api-error branch rather than the body-text signal fallback).
    const numeric429 = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      api_error_status: 429,
      result: 'API Error: 429 Too Many Requests',
      session_id: 'sess-test',
      uuid: 'uuid-test',
    });
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: numeric429 },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'api-num-429',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeApiError) {
      expect(caught.apiErrorStatus).toBe('429');
      expect(isRateLimitedApiError(caught)).toBe(true);
    }
  });

  test('an api-error envelope on the reformat retry still throws ClaudeApiError', async () => {
    const { exec, calls } = makeFakeExec([
      // First attempt: well-formed envelope, but the inner payload is prose.
      { ok: true, exitCode: 0, stdout: successEnvelope('not json at all') },
      // Retry attempt: the CLI now reports an API error.
      {
        ok: true,
        exitCode: 0,
        stdout: errorEnvelope({ is_error: true, result: 'API Error: overloaded' }),
      },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'api-3',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(calls).toHaveLength(2);
    if (caught instanceof ClaudeApiError) {
      expect(caught.result).toContain('overloaded');
    }
  });

  test('inner result unparseable on both attempts → MalformedLlmOutputError', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('prose one'), stderr: '' },
      { ok: true, exitCode: 0, stdout: successEnvelope('prose two'), stderr: '' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'malformed-inner',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedLlmOutputError);
    expect(calls).toHaveLength(2);
    if (caught instanceof MalformedLlmOutputError) {
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      // The dump records the inner-payload parse failure, not a transport one.
      expect(dump).toContain('envelope.result is not valid JSON');
    }
  });

  test('regression: exitCode 0 + non-JSON stdout stays on the MalformedLlmOutputError path', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: 'bad', stderr: '' },
      { ok: true, exitCode: 0, stdout: 'still bad', stderr: '' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'malformed-1',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedLlmOutputError);
    // The reformat retry still fires for non-empty, non-JSON stdout.
    expect(calls).toHaveLength(2);
  });

  // --- V1.2-3: RateLimitExhaustedError type ---

  describe('RateLimitExhaustedError', () => {
    test('exposes callId, attemptsBeforeFailure, lastAttemptDetail in the message', () => {
      const err = new RateLimitExhaustedError('cid-1', 4, 'API Error: 429 Too Many Requests');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RateLimitExhaustedError);
      expect(err.name).toBe('RateLimitExhaustedError');
      expect(err.callId).toBe('cid-1');
      expect(err.attemptsBeforeFailure).toBe(4);
      expect(err.lastAttemptDetail).toBe('API Error: 429 Too Many Requests');
      expect(err.message).toMatch(/cid-1/);
      expect(err.message).toMatch(/4 attempts/);
      expect(err.message).toMatch(/429 Too Many Requests/);
    });

    test('prototype chain is restored so instanceof works after transport', () => {
      const err = new RateLimitExhaustedError('cid', 1, 'detail');
      expect(Object.getPrototypeOf(err)).toBe(RateLimitExhaustedError.prototype);
    });
  });

  test('regression: exitCode 0 + valid success envelope returns the normal success path', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'ok-1',
    });
    const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  // =====================================================================
  // V1.3.3-3 witnesses — Bug A (prose-preamble JSON recovery in
  // `interpretEnvelope`). The V1.3.3-3 identity stub of
  // `extractJsonValue` returns the parse-failure sentinel
  // (`{ json: undefined, preamble: '' }`); these witnesses fail with
  // specific assertion mismatches against the existing
  // `MalformedLlmOutputError` retry path. V1.3.3-4 wires the real
  // extractor + the AH1 two-shape WARN line and turns them green.
  // =====================================================================

  describe('V1.3.3-3 Bug A — prose-preamble JSON recovery', () => {
    const stderrCapture: string[] = [];
    const realStderrWrite = process.stderr.write.bind(process.stderr);

    beforeEach(() => {
      stderrCapture.length = 0;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrCapture.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      }) as typeof process.stderr.write;
    });

    afterEach(() => {
      process.stderr.write = realStderrWrite;
    });

    test('prose-wrapped JSON on first attempt → recovered with no reformat retry; leading-prose WARN line on stderr (AH1)', async () => {
      // The cap_try Shop shape: envelope outer is well-formed, but
      // envelope.result carries `'The issue: …\n\n{...}'` — a prose
      // preamble followed by the real JSON body. Once V1.3.3-4 wires
      // `extractJsonValue`, this recovers on the first attempt with the
      // leading-prose WARN line.
      const proseShape =
        'The issue: controller module id mismatch.\n\n' +
        '{"newFileContent":"// recovered\\n"}';
      const { exec, calls } = makeFakeExec([
        { ok: true, exitCode: 0, stdout: successEnvelope(proseShape) },
        // Stub response in case the V1.3.3-3 retry path consumes a
        // second exec — the call-count assertion below catches it.
        { ok: true, exitCode: 0, stdout: successEnvelope(proseShape) },
      ]);
      const runner = new BinaryRunner({
        errorOutputDir: errorDir,
        execImpl: exec,
        callIdFactory: () => 'preamble-1',
      });
      // Wrap the throw so the witness fails with an assertion mismatch
      // (AH5), not an unhandled MalformedLlmOutputError under stubs.
      let result: Awaited<ReturnType<typeof runner.run>> | undefined;
      let caught: unknown;
      try {
        result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected recovery to succeed; threw under V1.3.3-3 stub').toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(result?.json).toEqual({ newFileContent: '// recovered\n' });
      expect(stderrCapture.join('')).toContain(
        '[WARN] LLM emitted prose preamble',
      );
    });

    test('(AH1 + AM4) trailing-prose recovery → no reformat retry; DISTINCT trailing-prose WARN line', async () => {
      // AH1: trailing-prose recovery has preamble === '' (extractor ran
      // but JSON was at offset 0); WARN line MUST fire with the
      // distinguishing message so a future "just emit one WARN shape"
      // refactor is caught. Pinning the wording is load-bearing.
      const trailingShape = '{"newFileContent":"// ok\\n"}\nHope this helps!';
      const { exec, calls } = makeFakeExec([
        { ok: true, exitCode: 0, stdout: successEnvelope(trailingShape) },
        { ok: true, exitCode: 0, stdout: successEnvelope(trailingShape) },
      ]);
      const runner = new BinaryRunner({
        errorOutputDir: errorDir,
        execImpl: exec,
        callIdFactory: () => 'preamble-trail',
      });
      let result: Awaited<ReturnType<typeof runner.run>> | undefined;
      let caught: unknown;
      try {
        result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected recovery to succeed; threw under V1.3.3-3 stub').toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(result?.json).toEqual({ newFileContent: '// ok\n' });
      expect(stderrCapture.join('')).toContain(
        '[WARN] LLM emitted trailing prose after JSON body',
      );
    });

    test('(AM4) happy-path negative pin: clean envelope.result → no WARN line on stderr', async () => {
      // Negative witness so the WARN logic doesn't accidentally fire on
      // clean input. Pinning the absence catches a regression that
      // would otherwise be silent.
      const { exec, calls } = makeFakeExec([
        { ok: true, exitCode: 0, stdout: successEnvelope('{"a":1}') },
      ]);
      const runner = new BinaryRunner({
        errorOutputDir: errorDir,
        execImpl: exec,
        callIdFactory: () => 'clean-1',
      });
      const result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
      expect(calls).toHaveLength(1);
      expect(result.json).toEqual({ a: 1 });
      const stderrText = stderrCapture.join('');
      expect(stderrText).not.toMatch(/\[WARN\] LLM emitted (prose|trailing)/);
    });

    test('irrecoverable preamble on first attempt → reformat retry still fires unchanged', async () => {
      // Pure prose (no `{` / `[`) cannot be recovered by the extractor —
      // the call falls through to the existing one-shot reformat retry,
      // and if THAT fails too the existing MalformedLlmOutputError
      // behaviour kicks in. Recovery is additive, never replaces retry.
      const { exec, calls } = makeFakeExec([
        { ok: true, exitCode: 0, stdout: successEnvelope('prose with no braces') },
        { ok: true, exitCode: 0, stdout: successEnvelope('still no braces') },
      ]);
      const runner = new BinaryRunner({
        errorOutputDir: errorDir,
        execImpl: exec,
        callIdFactory: () => 'irrecov-1',
      });
      let caught: unknown;
      try {
        await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MalformedLlmOutputError);
      // Existing retry path is unchanged — exactly two exec calls.
      expect(calls).toHaveLength(2);
    });

    test('(AM5) recovered preamble + schema-invalid inner JSON → recovery succeeds, schema layer (downstream) rejects, no audit dump for the schema failure', async () => {
      // AM5 pins the recovery-vs-schema layering so a future refactor
      // that conflates recovery with schema acceptance is caught.
      // - The recovery layer (interpretEnvelope / extractJsonValue) is
      //   happy: the inner payload parses to a valid JSON object after
      //   the preamble is stripped.
      // - The schema layer (`safeJson(result.raw, fixProposalSchema)`)
      //   is unhappy: the object is missing the required
      //   `newFileContent` field.
      // - The audit dump (`llm-error-*.txt`) is for malformed-output
      //   retries; a schema rejection at a different layer must NOT
      //   write one (no error was raised by the runner).
      const recoverableButSchemaInvalid =
        'The issue: I forgot the file contents.\n\n' +
        '{"unrelated":"no newFileContent here"}';
      const { exec, calls } = makeFakeExec([
        {
          ok: true,
          exitCode: 0,
          stdout: successEnvelope(recoverableButSchemaInvalid),
        },
        {
          ok: true,
          exitCode: 0,
          stdout: successEnvelope(recoverableButSchemaInvalid),
        },
      ]);
      const runner = new BinaryRunner({
        errorOutputDir: errorDir,
        execImpl: exec,
        callIdFactory: () => 'schema-miss',
      });
      let result: Awaited<ReturnType<typeof runner.run>> | undefined;
      let caught: unknown;
      try {
        result = await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
      } catch (err) {
        caught = err;
      }
      // Recovery layer succeeded — runner.run resolved cleanly.
      expect(
        caught,
        'recovery layer should have produced a result; threw under V1.3.3-3 stub',
      ).toBeUndefined();
      // Recovery succeeded — exactly one exec call (no retry).
      expect(calls).toHaveLength(1);
      // The runner returns the recovered inner JSON: object is present.
      expect(result?.json).toEqual({ unrelated: 'no newFileContent here' });
      // WARN line for the preamble still fires (recovery happened).
      expect(stderrCapture.join('')).toContain(
        '[WARN] LLM emitted prose preamble',
      );
      // No audit dump for the schema failure — it's a different layer.
      const errorFile = join(errorDir, 'llm-error-schema-miss.txt');
      expect(() => readFileSync(errorFile, 'utf8')).toThrow();
    });
  });
});

// =====================================================================
// V1.9.3 D2 — a 429 / rate-limit arriving as a NON-envelope body (plain
// text / truncated page) must be classified as rate-limited so
// `withRateLimitBackoff` engages the SPEC §2.12 schedule, instead of
// degrading to `MalformedLlmOutputError` (which `isRateLimitedApiError`
// cannot see). The transport boundary and the check-layer classifier share
// ONE regex (`RATE_LIMIT_SIGNAL_RE`); the no-signal cases prove no
// over-capture of a genuinely malformed body.
// =====================================================================

describe('BinaryRunner — D2: non-envelope rate-limit classification', () => {
  test('single source of truth: the leaf regex IS the one `_shared` re-exports', () => {
    // The transport guard and `isRateLimitedApiError` must recognise the same
    // surface; a divergent copy would silently re-open the misclassification.
    expect(RATE_LIMIT_SIGNAL_RE_REEXPORT).toBe(RATE_LIMIT_SIGNAL_RE);
  });

  test('first-body 429 (non-envelope) → rate-limit-classified ClaudeApiError, reformat retry SKIPPED', async () => {
    // A 429 the CLI passed through as plain text: exit 0 + non-empty stdout, so
    // it is NOT a process kill and reaches the retryable path. Before the fix
    // this fell through to the reformat retry and then MalformedLlmOutputError.
    const { exec, calls } = makeFakeExec([
      { ok: false, exitCode: 1, stdout: 'HTTP 429 Too Many Requests: rate limit exceeded.' },
      // A second response is present but must NOT be consumed — a 429 will not
      // reformat into valid JSON, so the retry is skipped (mirrors process-kill).
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'rl-first',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }

    // The thrown error is a ClaudeApiError the rate-limit classifier accepts —
    // NOT a MalformedLlmOutputError. Reverting either binary-runner guard makes
    // this a MalformedLlmOutputError → isRateLimitedApiError(false) → RED.
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(caught).not.toBeInstanceOf(MalformedLlmOutputError);
    expect(isRateLimitedApiError(caught)).toBe(true);
    // Reformat retry skipped — exactly one exec call.
    expect(calls).toHaveLength(1);
    if (caught instanceof ClaudeApiError) {
      expect(caught.callId).toBe('rl-first');
      expect(caught.apiErrorStatus).toBe('429');
      // The raw body is carried through `result` so the terminal
      // RateLimitExhaustedError detail and the dump stay faithful.
      expect(caught.result).toContain('429 Too Many Requests');
      const dump = readFileSync(caught.errorFilePath, 'utf8');
      expect(dump).toContain('RATE LIMITED (non-envelope body)');
      expect(dump).not.toContain('reformat retry)'); // not the malformed dump
      expect(dump).toContain('429 Too Many Requests');
    }
  });

  test('rate-limit signal on stderr (empty-ish stdout) is detected across both streams', async () => {
    // exit 0 keeps it on the retryable path (a non-zero exit with empty stdout
    // would be a process kill); the signal lives only on stderr.
    const { exec, calls } = makeFakeExec([
      { ok: false, exitCode: 0, stdout: 'unparseable', stderr: 'quota exhausted for this window' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'rl-stderr',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(isRateLimitedApiError(caught)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('rate-limit signal only on the reformat RETRY → still classified, after one retry', async () => {
    // First body is a generic parse failure (no signal) → reformat retry fires;
    // the retry body carries the 429 → the final-throw guard classifies it.
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: 'just broken, no signal here' },
      { ok: false, exitCode: 1, stdout: 'Error 429: too many requests, please retry' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'rl-second',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeApiError);
    expect(isRateLimitedApiError(caught)).toBe(true);
    // The reformat retry DID fire (first body had no signal) — two exec calls.
    expect(calls).toHaveLength(2);
  });

  test('no over-capture: a malformed body without a rate-limit signal → MalformedLlmOutputError', async () => {
    // Includes a near-miss ("quotation", which `\bquota\b` must NOT match) to
    // prove the guard fires only on a genuine rate-limit signal.
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: 'broken output with stray quotation marks' },
      { ok: true, exitCode: 0, stdout: 'still broken, no signal' },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'not-rl',
    });

    let caught: unknown;
    try {
      await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedLlmOutputError);
    expect(isRateLimitedApiError(caught)).toBe(false);
    // Reformat retry still fires for a non-signal malformed body.
    expect(calls).toHaveLength(2);
  });
});

describe('V1.9.4 PERF-17 — user-selectable model (--model)', () => {
  // TR-1 (V1.9.6): the exact FLAGS-ONLY argv a no-model, no-system-prompt call
  // assembles — the prompt travels via stdin and is never a positional. The
  // byte-identical baseline: the model thread-through must add nothing here.
  const BASE_ARGV: readonly string[] = [
    '-p',
    '--output-format',
    'json',
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
  ];

  test('buildClaudeExecArgs WITHOUT model is byte-identical to today (no --model)', () => {
    // Fail-on-revert guard: the "no model id in code" invariant rests on an
    // unset model emitting nothing. If the `--model` push ever fires
    // unconditionally, this exact-equality assertion goes red.
    const argv = buildClaudeExecArgs({ tools: ALLOWED_TOOLS });
    expect(argv).toEqual(BASE_ARGV);
    expect(argv).not.toContain('--model');
  });

  test('buildClaudeExecArgs WITH model appends `--model <id>` after the base argv', () => {
    const argv = buildClaudeExecArgs({
      tools: ALLOWED_TOOLS,
      model: 'cheaper-model-id',
    });
    expect(argv).toEqual([...BASE_ARGV, '--model', 'cheaper-model-id']);
  });

  test('buildClaudeExecArgs forwards the model verbatim — no alias mapping', () => {
    // The flag is free-form: whatever id the user supplies is sent unchanged.
    const argv = buildClaudeExecArgs({ tools: ALLOWED_TOOLS, model: 'X-99' });
    const ix = argv.indexOf('--model');
    expect(ix).toBeGreaterThan(-1);
    expect(argv[ix + 1]).toBe('X-99');
  });

  test('--model composes with --system-prompt (both pushed; model last)', () => {
    const argv = buildClaudeExecArgs({
      tools: ALLOWED_TOOLS,
      systemPrompt: 'be terse',
      model: 'm-1',
    });
    expect(argv).toContain('--system-prompt');
    expect(argv).toContain('be terse');
    const sysIx = argv.indexOf('--system-prompt');
    const modelIx = argv.indexOf('--model');
    expect(modelIx).toBeGreaterThan(sysIx);
    expect(argv[modelIx + 1]).toBe('m-1');
  });

  test('buildClaudeArgs carries model onto ClaudeRunArgs only when set', () => {
    expect(buildClaudeArgs({ prompt: 'p', cwd: '/w' }).model).toBeUndefined();
    expect(buildClaudeArgs({ prompt: 'p', cwd: '/w', model: 'm-2' }).model).toBe('m-2');
  });

  test('BinaryRunner.run forwards args.model to the spawned `claude -p --model`', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'model-call',
    });
    await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w', model: 'run-model' }));
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.args ?? [];
    const ix = argv.indexOf('--model');
    expect(ix).toBeGreaterThan(-1);
    expect(argv[ix + 1]).toBe('run-model');
  });

  test('BinaryRunner.run WITHOUT model spawns no --model (byte-identical argv)', async () => {
    const { exec, calls } = makeFakeExec([
      { ok: true, exitCode: 0, stdout: successEnvelope('{"ok":true}') },
    ]);
    const runner = new BinaryRunner({
      errorOutputDir: errorDir,
      execImpl: exec,
      callIdFactory: () => 'no-model-call',
    });
    await runner.run(buildClaudeArgs({ prompt: 'p', cwd: '/w' }));
    expect(calls[0]?.args).toEqual(BASE_ARGV);
    expect(calls[0]?.args).not.toContain('--model');
    // TR-1: the prompt reached the runner via stdin, not argv.
    expect(calls[0]?.input).toBe('p');
  });
});
