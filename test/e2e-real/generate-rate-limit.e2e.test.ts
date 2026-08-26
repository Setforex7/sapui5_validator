/**
 * V1.3-2 — gated E2E placeholder for the `generate` rate-limit exit path.
 *
 * Like `rate-limit-graceful.e2e.test.ts` (the validate-side equivalent), this
 * file is intentionally a documented skeleton with no spawned-CLI scenario.
 * Triggering a real `claude` rate limit deterministically would require
 * either burning the user's Max-plan budget on demand (slow, flaky, and worst
 * case leaves the plan throttled) or injecting a binary mock into
 * `BinaryRunner` (which breaks the "BinaryRunner is the single transport
 * boundary" invariant — CLAUDE.md §Conventions / SPEC §1.5). Both were
 * rejected for the validate-side test; the argument is identical for generate.
 *
 * Real regression coverage for the generate rate-limit path is the
 * integration test added in V1.3-3 (`test/integration/generate.test.ts`) with
 * a `FakeClaudeRunner` that throws `RateLimitExhaustedError`, mirroring
 * validate's integration coverage: it asserts the `rate-limited` exit reason,
 * `report.json` written before exit, and the audit-log skeleton intact.
 *
 * This file exists so the generate E2E suite has a visible, named slot for
 * the rate-limit path; it stays skipped until a stable non-mock trigger
 * surface exists (e.g. a saved `rate-limited` report consumed by a future
 * `--resume`, per the V1.3+ backlog).
 */
import { describe, test } from 'vitest';
import { E2E_REAL_ENABLED } from './_shared.js';

describe.skipIf(!E2E_REAL_ENABLED)('V1.3-2 — generate rate-limit graceful exit', () => {
  test.skip('deferred — see header comment for rationale', () => {
    // Intentionally skipped. See file header comment.
  });
});
