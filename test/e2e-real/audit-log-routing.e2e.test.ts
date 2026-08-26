/**
 * Bug 7 — audit log routing witness test.
 *
 * Folded into Bug 5's fix scope (V1.1-4). Distinct from Bug 5 in that this
 * test asserts the *shape* of the audit-log layout, not merely that it is
 * non-empty:
 *
 *   - Every file in `responses/` has a corresponding file in `prompts/` with
 *     the same callId stem. The runner's callId is the only correlation
 *     handle between "what we asked Claude" and "what Claude returned", and
 *     `AuditLog.writePrompt` / `writeResponse` both key off it
 *     ([src/audit/log.ts:34-46](../../src/audit/log.ts#L34-L46)). A response
 *     written without the matching prompt indicates a routing bug.
 *   - Every file in `verify/` is named `<callId>-<step>.txt` where step is
 *     one of ui5lint / eslint / karma, matching the `AuditLog.writeVerify`
 *     contract ([src/audit/log.ts:48-53](../../src/audit/log.ts#L48-L53)).
 *
 * Failure progression expected across the V1.1 fix sessions:
 *   - Today  (V1.1-3):  zero responses → vacuously fails the "responses
 *                       exists & non-empty" precondition.
 *   - V1.1-4 (Bug 5):   audit log wired up; this test starts passing for
 *                       the prompt/response correlation portion.
 *   - V1.1-8 (Bug 3):   verify dumps land; the verify-filename portion
 *                       gates on real fix-loop iterations occurring.
 */

import { extname } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  E2E_REAL_ENABLED,
  PATHS,
  lastRunSummary,
  listDir,
} from './_shared.js';

const VERIFY_STEPS = ['ui5lint', 'eslint', 'karma'] as const;
type VerifyStep = (typeof VERIFY_STEPS)[number];

function stem(filename: string): string {
  return filename.slice(0, filename.length - extname(filename).length);
}

/**
 * Parses a verify filename of the form `<callId>-<step>.txt`. Returns null
 * for any filename that does not match the contract.
 */
function parseVerifyName(name: string): { callId: string; step: VerifyStep } | null {
  if (!name.endsWith('.txt')) return null;
  const noExt = name.slice(0, -'.txt'.length);
  for (const step of VERIFY_STEPS) {
    const suffix = `-${step}`;
    if (noExt.endsWith(suffix)) {
      const callId = noExt.slice(0, -suffix.length);
      if (callId.length > 0) return { callId, step };
    }
  }
  return null;
}

describe.skipIf(!E2E_REAL_ENABLED)('Bug 7 — audit log routing is well-formed', () => {
  test('every responses/<callId>.json has a matching prompts/<callId>.txt', () => {
    const responses = listDir(PATHS.responsesDir);
    expect(
      responses.length,
      `expected responses/ to be non-empty so routing can be inspected.\n` +
        `Last-run summary:\n${lastRunSummary()}`,
    ).toBeGreaterThan(0);

    const promptStems = new Set(listDir(PATHS.promptsDir).map(stem));
    const orphans = responses.filter((r) => !promptStems.has(stem(r)));
    expect(
      orphans,
      `expected every response to correlate to a prompt by callId stem; ` +
        `found ${orphans.length} orphan response(s): ${orphans.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  });

  test('every verify/<callId>-<step>.txt parses and step is one of ui5lint|eslint|karma', () => {
    const verify = listDir(PATHS.verifyDir);
    expect(
      verify.length,
      `expected verify/ to be non-empty so routing can be inspected.\n` +
        `Last-run summary:\n${lastRunSummary()}`,
    ).toBeGreaterThan(0);

    const malformed = verify.filter((v) => parseVerifyName(v) === null);
    expect(
      malformed,
      `expected every verify dump to be named "<callId>-<step>.txt" with step in ` +
        `{ui5lint, eslint, karma}; found ${malformed.length} malformed: ` +
        `${malformed.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  });
});
