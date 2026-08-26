/**
 * V1.2-3 (Feature 1, Session V1.2-3) — gated end-to-end coverage placeholder
 * for the graceful rate-limit exit path.
 *
 * # Why this file is intentionally empty (no spawned-CLI scenarios)
 *
 * Triggering a real `claude` rate-limit deterministically would require one
 * of two impractical options:
 *
 *   1. **Burning the user's Max plan budget on demand.** This is slow,
 *      flaky, and worst case leaves the user's plan throttled for the rest
 *      of the day. Even when it does fire it produces a single witness —
 *      the inverse of a useful regression test.
 *
 *   2. **Injecting a `CLAUDE_BIN_MOCK` environment variable into
 *      `BinaryRunner` that swaps the real `claude` binary for a script that
 *      always returns a 429 envelope.** This adds a production-path surface
 *      area whose only consumer is a test, and breaks the "BinaryRunner is
 *      the single transport boundary" invariant from CLAUDE.md §Conventions
 *      / SPEC.md §1.5. We rejected this in the V1.2-3 design discussion.
 *
 * The V1.2-1 precedent (`dynamic-budget.e2e.test.ts`) reaches the new code
 * path with `--max-llm-calls 0`, which forces the first `consume()` to
 * throw — a deterministic budget-side trigger. **There is no comparable
 * budget-side trigger for rate-limit-exhaustion**, because the rate-limit
 * classifier reads `claude`'s stderr/raw output, which the orchestrator does
 * not control without a mock.
 *
 * The validate-level integration test
 * (`test/integration/validate.test.ts` → "V1.2-3 graceful rate-limit
 * handling") drives the full orchestrator end-to-end against the
 * minimal-project fixture with a `FakeClaudeRunner` that throws
 * `RateLimitExhaustedError`. That test covers:
 *
 *   - the dedicated `rate-limited` exit reason is set;
 *   - `callsCompleted` mirrors `report.llmCallCount`;
 *   - the `report.json` is written before exit (no data loss);
 *   - the audit log skeleton (last-run/{prompts,responses,verify}) survives;
 *   - the interaction with V1.2-2 `cappedChecks` is preserved;
 *   - mid-refinement rate-limit reverts the in-progress file to its
 *     original bytes.
 *
 * Together with the unit tests on `RateLimitExhaustedError` /
 * `withRateLimitBackoff.throwOnExhaustion` / `callLlmForFindings`'s catch
 * chain, those scenarios give the rate-limit path the same regression
 * coverage as `BudgetExhaustedError` and `ClaudeApiError`.
 *
 * When `--resume` lands (V1.3+ backlog) the resume entry point will need
 * its own E2E witness; that work brings a stable trigger surface (a saved
 * `rate-limited` report on disk) that *can* be exercised without mocking
 * the binary. This file will be expanded then.
 */
import { describe, test } from 'vitest';
import { E2E_REAL_ENABLED } from './_shared.js';

describe.skipIf(!E2E_REAL_ENABLED)('V1.2-3 — rate-limit graceful exit', () => {
  test.skip('deferred — see header comment for rationale', () => {
    // Intentionally skipped. See file header comment.
  });
});
