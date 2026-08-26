/**
 * V1.2-4 (Feature 2 — User-friendly error messages). One test file owning the
 * full inventory of user-facing message text:
 *
 *   - Every `extends Error` class from SPEC's typed-error set produces a
 *     human-friendly `.message` that names what happened, what the user can
 *     do, and (in a trailing parenthetical) carries the technical detail
 *     the audit log needs.
 *   - Every `ExitReason` variant maps through `formatExitMessage` to a
 *     non-null, accessible explanation (except `success`, which yields
 *     `null` so the CLI suppresses the stderr write entirely).
 *   - `--verbose` adds the inner technical detail for the three kinds
 *     whose inner detail materially helps debugging
 *     (`rate-limited`, `malformed-llm-output`, `error`); for every other
 *     kind it is a no-op.
 *
 * The V1.2-PLAN.md Feature 2 exit criteria require that all typed errors
 * have human-readable messages and that exit messages explain the next
 * step; this file is the contract.
 */

import { describe, expect, test } from 'vitest';
import {
  ClaudeApiError,
  ClaudeEnvelopeContractError,
  ClaudeProcessKilledError,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
} from '../../src/claude/binary-runner.js';
import { BudgetExhaustedError } from '../../src/claude/budget.js';
import { Ui5LintFileOutsideProjectError } from '../../src/verify/ui5lint.js';
import { ExcludedPathScopeError } from '../../src/commands/validate.js';
import { formatExitMessage } from '../../src/output/messages.js';
import { MISSING_CLAUDE_MESSAGE } from '../../src/claude/availability.js';
import { TS_REFUSAL_MESSAGE } from '../../src/project/ts-guard.js';
import type { ExitReason } from '../../src/types.js';

describe('typed Error classes: user-friendly .message', () => {
  test('MalformedLlmOutputError leads with the plain-language explanation, then the action, then the technical reference', () => {
    const err = new MalformedLlmOutputError('cid-malformed', '/tmp/llm-error-cid.txt');
    // Accessible explanation comes first.
    expect(err.message).toMatch(/could not be parsed/i);
    // Pointer to the saved artifact is present (action: inspect the file).
    expect(err.message).toContain('/tmp/llm-error-cid.txt');
    // Technical id stays for the audit log.
    expect(err.message).toContain('cid-malformed');
    // No leftover "Malformed Claude output for call" jargon header.
    expect(err.message).not.toMatch(/^Malformed Claude output for call/);
  });

  test('ClaudeEnvelopeContractError (TR-2) names the contract drift, the likely cause, and where to look', () => {
    const err = new ClaudeEnvelopeContractError(
      'cid-drift',
      'unexpected claude envelope shape: bad',
      '/tmp/llm-error-drift.txt',
    );
    // What happened: the OUTER envelope shape mismatched — not "malformed output".
    expect(err.message).toMatch(/envelope shape does not match/i);
    // Likely cause: an unvalidated CLI version.
    expect(err.message).toMatch(/version this tool has not been validated against/i);
    // Where to look + call id for the audit log.
    expect(err.message).toContain('/tmp/llm-error-drift.txt');
    expect(err.message).toContain('cid-drift');
    // The zod detail is carried for the dump/consumers.
    expect(err.detail).toBe('unexpected claude envelope shape: bad');
    // Distinct from the malformed-model-output framing.
    expect(err.message).not.toMatch(/could not be parsed after one reformat retry/i);
  });

  test('ClaudeProcessKilledError explains what happened, the likely cause, and where to look', () => {
    const err = new ClaudeProcessKilledError('cid-killed', 137, '', '/tmp/llm-error-killed.txt');
    expect(err.message).toMatch(/exited before producing output/i);
    // Probable cause framing — helps the user diagnose without reading source.
    expect(err.message).toMatch(/killed by the system|signal|out of memory|interrupt/i);
    expect(err.message).toContain('137');
    expect(err.message).toContain('/tmp/llm-error-killed.txt');
    expect(err.message).toContain('cid-killed');
  });

  test('RateLimitExhaustedError leads with the user-facing framing and the concrete next step', () => {
    const err = new RateLimitExhaustedError('cid-rl', 4, 'API Error: 429 Too Many Requests');
    expect(err.message).toMatch(/rate limit/i);
    expect(err.message).toMatch(/wait/i);
    expect(err.message).toMatch(/5 minutes/);
    // Technical fields retained in the parenthetical so binary-runner.test.ts
    // and the audit-log consumers still see them.
    expect(err.message).toContain('cid-rl');
    expect(err.message).toContain('4 attempts');
    expect(err.message).toContain('429 Too Many Requests');
  });

  test('ClaudeApiError tells the user what kind of failure it is and where to look', () => {
    const err = new ClaudeApiError(
      'cid-api',
      'error',
      true,
      '429',
      'API Error: 429 Too Many Requests',
      '/tmp/llm-error-api.txt',
    );
    expect(err.message).toMatch(/API error/);
    // Three plausible causes listed so the user knows where to start.
    expect(err.message).toMatch(/authentication/i);
    expect(err.message).toMatch(/rate limit/i);
    expect(err.message).toMatch(/service/i);
    expect(err.message).toContain('/tmp/llm-error-api.txt');
    expect(err.message).toContain('cid-api');
    expect(err.message).toContain('subtype "error"');
    expect(err.message).toContain('api_error_status "429"');
  });

  test('ClaudeApiError omits api_error_status when null but keeps the call/subtype reference', () => {
    const err = new ClaudeApiError(
      'cid-api-2',
      'error_max_turns',
      false,
      null,
      'Reached the maximum number of turns.',
      '/tmp/llm-error-api2.txt',
    );
    expect(err.message).toContain('subtype "error_max_turns"');
    expect(err.message).not.toContain('api_error_status');
    expect(err.message).toContain('cid-api-2');
  });

  test('BudgetExhaustedError names the cap-vs-attempted counts AND suggests the three flags that recover', () => {
    const err = new BudgetExhaustedError(51, 50);
    expect(err.message).toMatch(/budget was reached/i);
    expect(err.message).toContain('51');
    expect(err.message).toContain('50');
    // The user-friendly next steps must be enumerated.
    expect(err.message).toContain('--max-llm-calls');
    expect(err.message).toContain('--per-check-cap');
    expect(err.message).toMatch(/narrow the scope/i);
  });

  test('Ui5LintFileOutsideProjectError explains the constraint AND offers the two recovery paths', () => {
    const err = new Ui5LintFileOutsideProjectError('/foreign/path/file.js', '/project/root');
    expect(err.message).toMatch(/outside the project root/i);
    // Recovery path 1: run from the right directory.
    expect(err.message).toMatch(/run sapui5-validate from the directory/i);
    // Recovery path 2: pass a path inside the project.
    expect(err.message).toMatch(/path inside the project/i);
    expect(err.message).toContain('/foreign/path/file.js');
    expect(err.message).toContain('/project/root');
  });

  test('ExcludedPathScopeError explains why the path was rejected AND the planned workaround', () => {
    const err = new ExcludedPathScopeError('webapp/vendor/jquery.min.js');
    expect(err.message).toContain('webapp/vendor/jquery.min.js');
    expect(err.message).toMatch(/vendor or minified code/i);
    // The exclusion list is shown so the user can see why the path matched.
    expect(err.message).toContain('vendor/');
    expect(err.message).toContain('*.min.js');
    // Pointer to the planned workaround.
    expect(err.message).toContain('--force-include');
  });
});

describe('formatExitMessage: every ExitReason kind has a user-friendly stderr message', () => {
  test('success: returns null (no stderr line emitted)', () => {
    expect(formatExitMessage({ kind: 'success' })).toBeNull();
  });

  test('unfixed-findings: states the count and points at the real report.json path', () => {
    const msg = formatExitMessage({ kind: 'unfixed-findings', remaining: 3 });
    expect(msg).not.toBeNull();
    // D5 (V1.9.1): neutral "N remaining" wording — the old "3 reverted" pinned a
    // bug (remaining mixes truly-reverted + never-attempted surfaced findings).
    expect(msg).toContain('3 remaining');
    expect(msg).not.toContain('reverted');
    // I1 (V1.5): the report lives at .sapui5-validator/report.json, NOT under last-run/.
    expect(msg).toContain('.sapui5-validator/report.json');
    expect(msg).not.toContain('last-run/report.json');
  });

  test('unfixed-findings: D5 — honest wording, never claims surfaced findings were "reverted after 3 attempts"', () => {
    // D5 (V1.9.1): reason.remaining = revertedAutoFixes + unpreloadedUnfixed; the
    // unpreloaded portion is surfaced (deterministic baseline-unpreloaded-libs
    // findings), NEVER run through the 3-retry apply-and-revert loop. So the old
    // "N reverted after 3 attempts each" phrasing was factually false whenever
    // unpreloadedUnfixed > 0 (the fresh cap_try_ts run printed "4 reverted after
    // 3 attempts each" while zero fixes were reverted). Fails on revert: the old
    // wording re-introduces "reverted after 3 attempts" and drops "4 remaining".
    const msg = formatExitMessage({ kind: 'unfixed-findings', remaining: 4 });
    expect(msg).not.toBeNull();
    expect(msg).not.toContain('reverted after 3 attempts');
    expect(msg).toContain('4 remaining');
  });

  test('baseline-failed: names the baseline tools and suggests fixing them first', () => {
    const msg = formatExitMessage({ kind: 'baseline-failed' });
    expect(msg).toMatch(/baseline check/i);
    expect(msg).toMatch(/ui5lint/);
    expect(msg).toMatch(/eslint/);
    expect(msg).toMatch(/fix the reported failures/i);
  });

  test('dirty-tree: suggests commit / stash / --force', () => {
    const msg = formatExitMessage({ kind: 'dirty-tree' });
    expect(msg).toMatch(/uncommitted/i);
    expect(msg).toMatch(/commit/i);
    expect(msg).toMatch(/stash/i);
    expect(msg).toMatch(/--force/);
  });

  test('not-sapui5-project: names the path and points at ui5.yaml / manifest.json', () => {
    const msg = formatExitMessage({ kind: 'not-sapui5-project', path: '/some/dir' });
    expect(msg).toContain('/some/dir');
    expect(msg).toMatch(/ui5\.yaml/);
    expect(msg).toMatch(/manifest\.json/);
  });

  test('typescript-project: emits the verbatim SPEC §2.5 refusal text', () => {
    expect(formatExitMessage({ kind: 'typescript-project' })).toBe(TS_REFUSAL_MESSAGE);
  });

  test('missing-claude: human-friendly framing AND the install/login command', () => {
    const msg = formatExitMessage({ kind: 'missing-claude' });
    expect(msg).toMatch(/claude cli was not found/i);
    expect(msg).toContain(MISSING_CLAUDE_MESSAGE);
  });

  test('missing-required-tooling: lists the missing tools and how to install each', () => {
    const msg = formatExitMessage({
      kind: 'missing-required-tooling',
      tools: ['ui5lint', 'karma'],
    });
    expect(msg).toContain('ui5lint');
    expect(msg).toContain('karma');
    expect(msg).toContain('@ui5/linter');
    expect(msg).toContain('karma-qunit');
  });

  test('karma-unavailable: distinguishes a broken runner from missing tooling and red tests', () => {
    const msg = formatExitMessage({ kind: 'karma-unavailable' });
    expect(msg).not.toBeNull();
    // What happened: karma is installed but could not start.
    expect(msg).toMatch(/could not start/i);
    // The three likely causes are named.
    expect(msg).toMatch(/configuration error/i);
    expect(msg).toMatch(/browser launcher|headless chrome/i);
    expect(msg).toMatch(/plugin|karma-ui5/i);
    // What to do: confirm karma runs on its own, then where to look.
    expect(msg).toMatch(/karma start/);
    expect(msg).toContain('.sapui5-validator/last-run/');
  });

  test('malformed-llm-output: explains the parse failure and suggests re-run / issue', () => {
    const msg = formatExitMessage({ kind: 'malformed-llm-output', file: 'llm-error-x.txt' });
    expect(msg).toMatch(/could not be parsed/i);
    expect(msg).toMatch(/re-run/i);
    expect(msg).toMatch(/file an issue/i);
  });

  test('envelope-contract-mismatch (TR-2): names the CLI version and points at the CLI, not the project', () => {
    const msg = formatExitMessage({
      kind: 'envelope-contract-mismatch',
      version: '2.1.200 (Claude Code)',
      file: 'llm-error-drift.txt',
    });
    expect(msg).not.toBeNull();
    // The probed version is named so the incompatibility is attributable.
    expect(msg).toContain('2.1.200 (Claude Code)');
    // Points at the claude CLI, not the user's project — and is NOT the
    // malformed-output message (that would re-conflate the two exit reasons).
    expect(msg).toMatch(/claude cli/i);
    expect(msg).toMatch(/version incompatibility/i);
    expect(msg).toContain('@anthropic-ai/claude-code');
    expect(msg).not.toMatch(/could not be parsed after one reformat retry/i);
  });

  test('envelope-contract-mismatch: falls back to "an unknown version" when the version is absent', () => {
    const msg = formatExitMessage({ kind: 'envelope-contract-mismatch', file: 'x.txt' });
    expect(msg).toContain('an unknown version');
  });

  test('budget-exhausted: states the cap and suggests the three recovery flags', () => {
    const msg = formatExitMessage({ kind: 'budget-exhausted', calls: 50 });
    expect(msg).toContain('50');
    expect(msg).toContain('--max-llm-calls');
    expect(msg).toContain('--per-check-cap');
    expect(msg).toMatch(/narrow the scope/i);
  });

  test('no-tests-template-required: points at SPEC §2.4 and suggests an interactive TTY run', () => {
    const msg = formatExitMessage({ kind: 'no-tests-template-required' });
    expect(msg).toMatch(/template/i);
    // I4 (V1.5): §2.4 is the real "No-tests state" section; §2.16 is Configuration
    // and the previously-cited webapp/test/_template/ layout does not exist.
    expect(msg).toContain('SPEC §2.4');
    expect(msg).toMatch(/interactive|TTY/i);
  });

  test('cancelled-by-user: short confirmation, no other noise', () => {
    expect(formatExitMessage({ kind: 'cancelled-by-user' })).toBe('Run cancelled by user.');
  });

  test('rate-limited: explains rate limit, partial results, and the wait window', () => {
    const msg = formatExitMessage({
      kind: 'rate-limited',
      callsCompleted: 7,
      lastError: 'inner technical detail string',
    });
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toContain('7');
    expect(msg).toContain('.sapui5-validator/last-run/');
    expect(msg).toMatch(/5 minutes/);
    // Verbose-only: technical detail must NOT leak into the default message.
    expect(msg).not.toContain('inner technical detail');
  });

  test('error: surfaces the underlying message verbatim with a "Run failed" prefix', () => {
    const reason: ExitReason = { kind: 'error', message: 'inner error message' };
    expect(formatExitMessage(reason)).toBe('Run failed: inner error message');
  });
});

// SEC-5 (V1.8) — the stderr exit messages interpolate path/tools/file/lastError/
// message, which can carry project- or LLM-derived text. Terminal control/ANSI
// bytes must be stripped. Fails on revert: drop the stripControl calls and the
// ESC byte survives into the stderr string.
describe('formatExitMessage: SEC-5 control-char stripping', () => {
  test('not-sapui5-project strips control bytes from the path', () => {
    const msg = formatExitMessage({ kind: 'not-sapui5-project', path: '/tmp/\x1b[2Jevil' });
    expect(msg).not.toContain('\x1b');
    expect(msg).toContain('/tmp/[2Jevil');
  });

  test('missing-required-tooling strips control bytes from the tool list', () => {
    const msg = formatExitMessage({
      kind: 'missing-required-tooling',
      tools: ['ui5lint\x07', 'kar\rma'],
    });
    expect(msg).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(msg).toContain('ui5lint');
    expect(msg).toContain('karma');
  });

  test('error strips control bytes from the inner message', () => {
    const msg = formatExitMessage({ kind: 'error', message: 'boom\x1b[31m danger' });
    expect(msg).not.toContain('\x1b');
    expect(msg).toBe('Run failed: boom[31m danger');
  });

  test('rate-limited (verbose) strips control bytes from lastError', () => {
    const msg = formatExitMessage(
      { kind: 'rate-limited', callsCompleted: 1, lastError: 'API\x1b[2J 429' },
      { verbose: true },
    );
    expect(msg).not.toContain('\x1b');
    expect(msg).toContain('API[2J 429');
  });

  test('malformed-llm-output (verbose) strips control bytes from the saved path', () => {
    const msg = formatExitMessage(
      { kind: 'malformed-llm-output', file: 'llm\x1b[2J.txt' },
      { verbose: true },
    );
    expect(msg).not.toContain('\x1b');
    expect(msg).toContain('llm[2J.txt');
  });
});

describe('formatExitMessage: --verbose only appends technical detail for the kinds that benefit', () => {
  test('rate-limited adds the lastError as "Technical detail: ..." suffix when verbose', () => {
    const reason: ExitReason = {
      kind: 'rate-limited',
      callsCompleted: 2,
      lastError: 'Claude API: 429 Too Many Requests (cid-rl)',
    };
    const plain = formatExitMessage(reason, { verbose: false });
    const verbose = formatExitMessage(reason, { verbose: true });
    expect(plain).not.toContain('Claude API: 429 Too Many Requests');
    expect(verbose).toContain('Technical detail:');
    expect(verbose).toContain('Claude API: 429 Too Many Requests (cid-rl)');
  });

  test('malformed-llm-output adds the saved-path detail when verbose', () => {
    const reason: ExitReason = { kind: 'malformed-llm-output', file: 'llm-error-x.txt' };
    const plain = formatExitMessage(reason, { verbose: false });
    const verbose = formatExitMessage(reason, { verbose: true });
    expect(plain).not.toContain('llm-error-x.txt');
    expect(verbose).toContain('Technical detail:');
    expect(verbose).toContain('llm-error-x.txt');
  });

  test('envelope-contract-mismatch adds the saved-path detail when verbose', () => {
    const reason: ExitReason = {
      kind: 'envelope-contract-mismatch',
      version: '2.1.200',
      file: 'llm-error-drift.txt',
    };
    const plain = formatExitMessage(reason, { verbose: false });
    const verbose = formatExitMessage(reason, { verbose: true });
    expect(plain).not.toContain('llm-error-drift.txt');
    expect(verbose).toContain('Technical detail:');
    expect(verbose).toContain('llm-error-drift.txt');
  });

  test('verbose is a no-op for kinds whose default message already states the next action', () => {
    const cases: readonly ExitReason[] = [
      { kind: 'unfixed-findings', remaining: 1 },
      { kind: 'baseline-failed' },
      { kind: 'dirty-tree' },
      { kind: 'not-sapui5-project', path: '/x' },
      { kind: 'typescript-project' },
      { kind: 'missing-claude' },
      { kind: 'missing-required-tooling', tools: ['karma'] },
      { kind: 'karma-unavailable' },
      { kind: 'budget-exhausted', calls: 10 },
      { kind: 'no-tests-template-required' },
      { kind: 'cancelled-by-user' },
      { kind: 'error', message: 'boom' },
    ];
    for (const r of cases) {
      expect(formatExitMessage(r, { verbose: false })).toBe(
        formatExitMessage(r, { verbose: true }),
      );
    }
  });

  test('success returns null in both modes', () => {
    expect(formatExitMessage({ kind: 'success' }, { verbose: false })).toBeNull();
    expect(formatExitMessage({ kind: 'success' }, { verbose: true })).toBeNull();
  });
});
