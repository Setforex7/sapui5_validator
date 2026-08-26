/**
 * V1.9.6 (TR-1 + numeric-`api_error_status` fix) — the OVERSIZED-SEED STDIN
 * TRANSPORT witness (validate path). Re-scoped at the Phase 4 real gate from
 * the retired B1 argv-guard `-2` witness.
 *
 * History: pre-B1, the ~1 MB `webapp/util/oversized-input.js` seed (setup.ts)
 * pushed the assembled `claude -p` command line past the Windows
 * `CreateProcess` ceiling and the spawn died (`exitCode: -1`). B1 (V1.5) added
 * the pre-spawn argv guard at `CLAUDE_ARGV_LIMIT` (32,500 UTF-16 units), so the
 * same input was refused deterministically BEFORE any spawn (synthetic
 * `exitCode: -2`) — consuming no budget. This file used to pin that `-2` path.
 *
 * TR-1 (V1.9.6) moved the prompt OFF argv onto the child's stdin, so an
 * oversized embedded source body no longer inflates the command line: the B1
 * guard can no longer be tripped by a large PROMPT (only by an oversized
 * flags-only argv, unit-tested in `test/unit/binary-runner.test.ts`). The ~1 MB
 * seed now FLOWS via stdin and REACHES the API — which rejects it with a genuine
 * `is_error:true` HTTP 400 "prompt too long" (the batched 3-check prompt is
 * ~1.05M tokens, over the model's 1M limit). That 400's `api_error_status` is
 * the NUMBER 400; the V1.9.6 fix (accept `z.number()` in the envelope schema)
 * classifies it as a per-file `api-error` — a `ClaudeApiError` → `apiErrorFinding`
 * — so the run CONTINUES and validates the other files, instead of the run-fatal
 * `envelope-contract-mismatch` a numeric status used to trigger.
 *
 * The contract pinned here (the post-transport acceptance witness):
 *
 *     The ~1 MB seed is NOT pre-spawn killed (no `-2` argv-guard, no `-1` OS
 *     kill): it flows via stdin, reaches the API, and its too-long rejection
 *     surfaces as a per-file "Claude API error" finding — never "malformed
 *     output", never a process-kill — while the run COMPLETES (not a fatal
 *     `envelope-contract-mismatch` abort).
 *
 * The genuine real-kill `exitCode: -1` path (still reachable at the runner
 * layer, independent of the prompt transport) stays pinned by
 * `process-kill-real.e2e.test.ts` (R4.3).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  PATHS,
  readReport,
  reportExists,
} from './_shared.js';

const MALFORMED_RX = /malformed (?:output|llm output|json)/i;
/**
 * Kill-classification evidence in a finding narrative: the
 * ClaudeProcessKilledError lead-in (covers both the real-kill -1 and the
 * argv-guard -2 variants) or an explicit negative exit code.
 */
const KILL_RX =
  /(process\s+(?:terminated|killed|exited\s+(?:abnormally|before\s+producing\s+output)))|(\bexit(?:\s*code)?\s*[:=-]?\s*-\d+\b)/i;

interface ErrorCapture {
  readonly file: string;
  readonly hasGuardRefusal: boolean;
  readonly hasRealKill: boolean;
}

/**
 * Inspects `llm-error-*.txt` captures written by `BinaryRunner.persistKillError`
 * and classifies each as the B1 argv-guard refusal (`exitCode: -2`, stamped
 * pre-spawn) or a real kill (`exitCode: -1`).
 */
function loadErrorCaptures(): ErrorCapture[] {
  if (!existsSync(PATHS.lastRun)) return [];
  return readdirSync(PATHS.lastRun)
    .filter((n) => n.startsWith('llm-error-') && n.endsWith('.txt'))
    .map((n) => {
      const body = readFileSync(`${PATHS.lastRun}/${n}`, 'utf8');
      return {
        file: n,
        hasGuardRefusal: /exitCode:\s*-2/.test(body),
        hasRealKill: /exitCode:\s*-1/.test(body),
      } satisfies ErrorCapture;
    });
}

/** The searchable narrative of a finding: its explanation + message. */
function findingBlob(finding: { explanation?: unknown; message?: unknown }): string {
  const explanation =
    typeof finding.explanation === 'string' ? finding.explanation : '';
  const message = typeof finding.message === 'string' ? finding.message : '';
  return `${explanation}\n${message}`;
}

describe.skipIf(!E2E_REAL_ENABLED)('V1.9.6 — oversized validate seed flows via stdin → per-file API error, not a pre-spawn kill or fatal abort', () => {
  test('the oversized seed is NOT pre-spawn killed — no argv-guard (-2) or OS-kill (-1) capture', () => {
    const captures = loadErrorCaptures();
    const kills = captures.filter((c) => c.hasGuardRefusal || c.hasRealKill);
    expect(
      kills,
      `TR-1 (V1.9.6): the ~1 MB oversized-input.js seed now travels via stdin, so ` +
        `the assembled argv is flags-only — the B1 pre-spawn guard can no longer ` +
        `refuse it (exitCode -2) and the OS cannot kill the spawn (-1). Any ` +
        `llm-error capture present must be the API-error dump (the API rejecting ` +
        `the too-long prompt), NEVER a kill. A -2 here would mean the stdin ` +
        `transport regressed and the prompt went back onto argv. Captures: ` +
        `${JSON.stringify(captures, null, 2)}`,
    ).toEqual([]);
  });

  test('the seed surfaces as a per-file "Claude API error" finding (not malformed, not a kill) and the run COMPLETES', () => {
    expect(reportExists(), 'report.json not produced — see e2e-real setup.ts output').toBe(true);
    const report = readReport();

    // The numeric-api_error_status fix (V1.9.6): the API's 400 "prompt too long"
    // (numeric api_error_status) is isolated as a per-file api-error, so the run
    // CONTINUES — not the run-fatal envelope-contract-mismatch a numeric status
    // used to trigger (which left `files: []`).
    expect(
      report.exitReason.kind,
      `the oversized seed must not fatally abort the run — a per-call API error is ` +
        `isolated per file. exitReason: ${JSON.stringify(report.exitReason)}`,
    ).not.toBe('envelope-contract-mismatch');
    expect(
      report.files.length,
      'the run must have validated files (a fatal abort would leave files: [])',
    ).toBeGreaterThan(0);

    // Collect every finding whose narrative mentions the oversized input
    // (any check that ran against it could have produced one).
    const candidates = report.files
      .flatMap((f) => f.findings.map((finding) => ({ container: f.file, finding })))
      .filter(({ container, finding }) =>
        container.endsWith('oversized-input.js') ||
        finding.file.endsWith('oversized-input.js'),
      );
    expect(
      candidates.length,
      `expected at least one per-file finding referencing oversized-input.js (the ` +
        `API-error surfaced by the too-long prompt). report.files:\n` +
        `${JSON.stringify(report.files.map((f) => f.file), null, 2)}`,
    ).toBeGreaterThan(0);

    // At least one candidate must be the honest api-error classification
    // (apiErrorFinding: "Claude API error …" / "returned an error envelope …").
    const apiErrors = candidates.filter(({ finding }) => {
      const blob = findingBlob(finding);
      return /claude api error/i.test(blob) || /returned an error envelope/i.test(blob);
    });
    expect(
      apiErrors.length,
      `expected an honest "Claude API error" finding for the oversized seed; ` +
        `candidates: ${JSON.stringify(candidates.slice(0, 3), null, 2)}`,
    ).toBeGreaterThan(0);

    // And NONE may be misclassified as "malformed output" (the pre-D2 shape) or
    // a process-kill (the pre-transport -2 shape): the API returned a well-formed
    // error envelope, so both classifications would be wrong.
    const misclassified = candidates.filter(({ finding }) => {
      const blob = findingBlob(finding);
      return MALFORMED_RX.test(blob) || KILL_RX.test(blob);
    });
    expect(
      misclassified,
      `no oversized-seed finding may be classified as "malformed output" or a ` +
        `process-kill; found ${misclassified.length}: ` +
        `${JSON.stringify(misclassified.slice(0, 3), null, 2)}`,
    ).toEqual([]);
  });
});
