/**
 * AuditingRunner — the prompt/response audit decorator (src/audit/runner.ts).
 *
 * COR-2 (§2.2): the success-path transcript write is best-effort — a write
 * failure must NOT crash a call whose paid-for LLM result already succeeded.
 * COR-3 (§2.2): a `RateLimitExhaustedError` (the terminal backoff signal) must
 * still write both sides of the call so the routing invariant — "every prompt
 * has a sibling response on disk" — holds on that path too.
 */

import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuditingRunner } from '../../src/audit/runner.js';
import { AuditLog } from '../../src/audit/log.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { RateLimitExhaustedError } from '../../src/claude/binary-runner.js';
import { buildClaudeArgs, type ClaudeRunResult } from '../../src/claude/runner.js';

/**
 * An {@link AuditLog} that records writes in memory (subclass so it satisfies
 * the nominal `AuditLog` type the decorator's constructor requires — its
 * private fields make a structural fake impossible). `failWrites` simulates a
 * full-disk / locked-dir failure.
 */
class RecordingAuditLog extends AuditLog {
  readonly prompts: Array<{ callId: string; content: string }> = [];
  readonly responses: Array<{ callId: string; content: string }> = [];
  failWrites = false;

  constructor() {
    super({ projectRoot: tmpdir(), keepHistory: false });
  }

  override async writePrompt(callId: string, content: string): Promise<string> {
    if (this.failWrites) throw new Error('ENOSPC: no space left on device');
    this.prompts.push({ callId, content });
    return `prompts/${callId}.txt`;
  }

  override async writeResponse(callId: string, content: string): Promise<string> {
    if (this.failWrites) throw new Error('ENOSPC: no space left on device');
    this.responses.push({ callId, content });
    return `responses/${callId}.json`;
  }
}

const ARGS = buildClaudeArgs({ prompt: 'analyze this controller', cwd: '/proj' });

describe('AuditingRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('success path writes prompt + response under the result callId', async () => {
    const audit = new RecordingAuditLog();
    const inner = new FakeClaudeRunner([
      { match: /./, response: { raw: 'RAW-OUTPUT', callId: 'cid-ok' } },
    ]);
    const result = await new AuditingRunner(inner, audit).run(ARGS);
    expect(result.callId).toBe('cid-ok');
    expect(audit.prompts).toEqual([{ callId: 'cid-ok', content: ARGS.prompt }]);
    expect(audit.responses).toEqual([{ callId: 'cid-ok', content: 'RAW-OUTPUT' }]);
  });

  test('PERF-1: forwards each successful result to the optional usage sink', async () => {
    // The AuditingRunner is the single decorator every production call flows
    // through, so it forwards each result's usage/cost to the run accumulator.
    // Reverting the `this.onResult?.(result)` call leaves `seen` empty → red.
    const audit = new RecordingAuditLog();
    const inner = new FakeClaudeRunner([
      {
        match: /./,
        response: {
          raw: '{"findings":[]}',
          callId: 'cid-usage',
          usage: {
            inputTokens: 6,
            outputTokens: 20,
            cacheReadTokens: 100,
            cacheCreationTokens: 200,
          },
          totalCostUsd: 0.05,
        },
      },
    ]);
    const seen: ClaudeRunResult[] = [];
    const result = await new AuditingRunner(inner, audit, (r) => seen.push(r)).run(ARGS);

    expect(result.callId).toBe('cid-usage');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage).toEqual({
      inputTokens: 6,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreationTokens: 200,
    });
    expect(seen[0]?.totalCostUsd).toBe(0.05);
  });

  test('COR-2: a success-path write failure warns but still returns the paid-for result', async () => {
    const audit = new RecordingAuditLog();
    audit.failWrites = true;
    const inner = new FakeClaudeRunner([
      { match: /./, response: { raw: '{"findings":[]}', callId: 'cid-ok' } },
    ]);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // Reverting the success-path try/catch makes this throw instead of return.
    const result = await new AuditingRunner(inner, audit).run(ARGS);

    expect(result.raw).toBe('{"findings":[]}');
    expect(warn).toHaveBeenCalled();
    const emitted = warn.mock.calls.map((c) => String(c[0])).join('');
    expect(emitted).toMatch(/failed to write audit transcript/i);
    expect(emitted).toMatch(/cid-ok/);
  });

  test('COR-3: a RateLimitExhaustedError still writes the prompt + response pair', async () => {
    const audit = new RecordingAuditLog();
    const inner = new FakeClaudeRunner([
      {
        match: /./,
        response: () => {
          throw new RateLimitExhaustedError('cid-rl', 4, 'API Error: 429 Too Many Requests');
        },
      },
    ]);
    const runner = new AuditingRunner(inner, audit);

    await expect(runner.run(ARGS)).rejects.toBeInstanceOf(RateLimitExhaustedError);

    // Routing invariant: the prompt AND a response both land under the error's
    // callId. Reverting the RateLimitExhaustedError catch arm orphans the
    // prompt (no pair), so both assertions below fail.
    expect(audit.prompts).toEqual([{ callId: 'cid-rl', content: ARGS.prompt }]);
    expect(audit.responses).toHaveLength(1);
    expect(audit.responses[0]?.callId).toBe('cid-rl');
    expect(audit.responses[0]?.content).toMatch(/RateLimitExhaustedError/);
    expect(audit.responses[0]?.content).toMatch(/attemptsBeforeFailure/);
  });
});
