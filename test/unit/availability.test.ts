import { describe, expect, test } from 'vitest';
import {
  claudeVersionWarning,
  MIN_TESTED_CLAUDE_VERSION,
  MISSING_CLAUDE_MESSAGE,
  probeClaudeAvailability,
} from '../../src/claude/availability.js';
import type { ExecResult } from '../../src/util/exec.js';

function fakeExec(result: Partial<ExecResult>) {
  return async (): Promise<ExecResult> => ({
    ok: result.ok ?? true,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
    durationMs: result.durationMs ?? 1,
  });
}

describe('probeClaudeAvailability', () => {
  test('returns ok with version when claude --version succeeds', async () => {
    const result = await probeClaudeAvailability({
      execImpl: fakeExec({ ok: true, exitCode: 0, stdout: '1.2.3\n' }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe('1.2.3');
  });

  test('returns failure with stderr reason when probe fails', async () => {
    const result = await probeClaudeAvailability({
      execImpl: fakeExec({ ok: false, exitCode: 127, stderr: 'command not found' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('command not found');
      expect(result.message).toBe(MISSING_CLAUDE_MESSAGE);
    }
  });

  test('falls back to a clear reason when stderr is empty', async () => {
    const result = await probeClaudeAvailability({
      binary: 'my-claude',
      execImpl: fakeExec({ ok: false, exitCode: 1, stderr: '' }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('my-claude --version');
      expect(result.reason).toContain('exited 1');
    }
  });

  test('SPEC §2.12 message text is unchanged', () => {
    expect(MISSING_CLAUDE_MESSAGE).toBe(
      'Install: npm i -g @anthropic-ai/claude-code, then run `claude /login` to authenticate.',
    );
  });

  test('D2 (V1.5): exercises only `claude --version` — never spends an LLM call to check auth', async () => {
    // The probe deliberately does NOT exercise auth at startup (that would burn
    // an LLM call before the user consented). This pins that design so a future
    // startup auth probe is a reviewed decision with a matching SPEC §2.12 update.
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const recordingExec = async (
      file: string,
      args: readonly string[] = [],
    ): Promise<ExecResult> => {
      calls.push({ file, args });
      return { ok: true, stdout: '1.0.0', stderr: '', exitCode: 0, durationMs: 1 };
    };
    await probeClaudeAvailability({ binary: 'claude', execImpl: recordingExec });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls.some((c) => c.args.includes('-p'))).toBe(false);
  });
});

describe('claudeVersionWarning (TR-2, V1.9.6)', () => {
  test('the tested floor itself is in range → no warning', () => {
    // The real CLI string carries a suffix; parsing must tolerate it.
    expect(claudeVersionWarning(`${MIN_TESTED_CLAUDE_VERSION} (Claude Code)`)).toBeNull();
    expect(claudeVersionWarning('2.1.200')).toBeNull();
  });

  test('a newer minor/patch on the tested major → no warning (newer is presumed compatible)', () => {
    expect(claudeVersionWarning('2.2.0')).toBeNull();
    expect(claudeVersionWarning('2.1.999')).toBeNull();
    expect(claudeVersionWarning('2.10.0 (Claude Code)')).toBeNull();
  });

  test('below the tested floor on the same major → warns, never hard-fails', () => {
    const w = claudeVersionWarning('2.1.199');
    expect(w).not.toBeNull();
    expect(w).toContain('2.1.199');
    expect(w).toContain('will still run');
  });

  test('a different major → warns (the real envelope-drift risk)', () => {
    expect(claudeVersionWarning('3.0.0')).not.toBeNull();
    expect(claudeVersionWarning('1.9.9')).not.toBeNull();
  });

  test('an unparseable version → warns rather than throwing', () => {
    const w = claudeVersionWarning('not-a-version');
    expect(w).not.toBeNull();
    expect(w).toContain('Could not parse');
  });
});
