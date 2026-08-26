import { describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { buildClaudeArgs } from '../../src/claude/runner.js';

describe('FakeClaudeRunner', () => {
  test('matches by substring and records calls', async () => {
    const runner = new FakeClaudeRunner([
      { match: 'check dom', response: { json: { findings: [] } } },
    ]);
    const args = buildClaudeArgs({ prompt: 'please check dom access', cwd: '/w' });
    const result = await runner.run(args);
    expect(result.json).toEqual({ findings: [] });
    expect(result.callId).toBe('fake-1');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toBe(args);
  });

  test('matches by RegExp', async () => {
    const runner = new FakeClaudeRunner([
      { match: /^generate qunit/i, response: { json: { files: [] } } },
    ]);
    const result = await runner.run(buildClaudeArgs({ prompt: 'Generate QUnit for X', cwd: '/w' }));
    expect(result.json).toEqual({ files: [] });
  });

  test('matches by predicate', async () => {
    const runner = new FakeClaudeRunner([
      {
        match: (a) => a.cwd === '/special',
        response: () => ({ json: { ok: true } }),
      },
    ]);
    const result = await runner.run(buildClaudeArgs({ prompt: 'whatever', cwd: '/special' }));
    expect(result.json).toEqual({ ok: true });
  });

  test('throws on unmatched prompt — never silently succeeds', async () => {
    const runner = new FakeClaudeRunner([]);
    await expect(
      runner.run(buildClaudeArgs({ prompt: 'unknown', cwd: '/w' })),
    ).rejects.toThrow(/no scripted response/);
  });

  test('response factory receives the args', async () => {
    const seen: string[] = [];
    const runner = new FakeClaudeRunner([
      {
        match: /.+/,
        response: (a) => {
          seen.push(a.prompt);
          return { json: { echo: a.prompt } };
        },
      },
    ]);
    const result = await runner.run(buildClaudeArgs({ prompt: 'hi', cwd: '/w' }));
    expect(result.json).toEqual({ echo: 'hi' });
    expect(seen).toEqual(['hi']);
  });

  test('enqueue appends entries at runtime', async () => {
    const runner = new FakeClaudeRunner();
    runner.enqueue({ match: 'late', response: { json: { late: true } } });
    const result = await runner.run(buildClaudeArgs({ prompt: 'late binding', cwd: '/w' }));
    expect(result.json).toEqual({ late: true });
  });

  test('callIdFactory injection produces deterministic ids', async () => {
    let n = 0;
    const runner = new FakeClaudeRunner(
      [{ match: /./, response: { json: {} } }],
      {
        callIdFactory: () => {
          n += 1;
          return `c-${n}`;
        },
      },
    );
    const a = await runner.run(buildClaudeArgs({ prompt: 'a', cwd: '/' }));
    const b = await runner.run(buildClaudeArgs({ prompt: 'b', cwd: '/' }));
    expect(a.callId).toBe('c-1');
    expect(b.callId).toBe('c-2');
  });
});
