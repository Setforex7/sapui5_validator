/**
 * The canonical rate-limit signal, factored into a leaf module so the transport
 * layer (`claude/binary-runner.ts`) and the check-layer classifiers
 * (`checks/_shared.ts` — {@link isRateLimitedResult} / {@link isRateLimitedApiError})
 * share ONE source of truth without an import cycle.
 *
 * `_shared.ts` already imports the error classes *from* `binary-runner.ts`, so
 * defining the regex in `_shared.ts` and importing it back into `binary-runner.ts`
 * (the V1.9.3 D2 fix needs it there) would create
 * `binary-runner → _shared → binary-runner`. This module depends on neither, so
 * both can import it freely; `_shared.ts` re-exports it for back-compat.
 *
 * The `claude` CLI's exact error text is unstable; this matches "rate limit",
 * HTTP 429, "too many requests", or "quota". The `i` flag only — no `g`, so
 * `.test()` is stateless and safe to share across call sites.
 */
export const RATE_LIMIT_SIGNAL_RE = /\b(rate.?limit(?:ed|s)?|429|too\s+many\s+requests|quota)\b/i;

/**
 * THR-4 (V1.9.7) — the pool-wide rate-limit signal. One instance is shared by
 * every worker in a concurrent `generate` run (`src/commands/generate.ts`):
 *
 *   - the per-call backoff schedule ({@link withRateLimitBackoff} in
 *     `claude/budget.ts`) calls {@link enterBackoff} the moment a worker first
 *     backs off on a 429 and {@link exitBackoff} when that schedule resolves
 *     (recovered OR exhausted — always, via a `finally`);
 *   - the pool dispatch loop (`runGeneratorPool`'s `worker()`) awaits
 *     {@link waitUntilClear} before claiming a NEW candidate.
 *
 * The effect: while any worker is in a 429 backoff window, the pool drains new
 * dispatches instead of piling K parallel `claude -p` calls onto a hot quota
 * window (each of which would burn its own backoff schedule and budget); when
 * the window clears, K is restored. The backing-off worker's OWN retry is never
 * paused — that IS the recovery path — only *new* dispatch is.
 *
 * A pure counter + parked-waiter list: dependency-free (leaf module, so both the
 * transport and pool layers import it without a cycle) and clock-free, so the
 * interleaving is deterministic under test. Not thread-safe in the OS sense and
 * needn't be — Node runs this on one event-loop thread; the only concurrency is
 * cooperative `await` interleaving.
 */
export class RateLimitSignal {
  /** Number of worker schedules currently inside a backoff window. */
  private active = 0;
  /** Workers parked in {@link waitUntilClear}, woken when `active` hits 0. */
  private readonly waiters: Array<() => void> = [];

  /** True while ≥1 worker is inside a rate-limit backoff window. */
  get backingOff(): boolean {
    return this.active > 0;
  }

  /** A worker observed a 429 and is about to back off — close the dispatch gate. */
  enterBackoff(): void {
    this.active += 1;
  }

  /**
   * A worker's backoff schedule ended (recovered or exhausted). When the last
   * active window clears, reopen the gate and wake every parked worker. Guarded
   * against underflow so a stray double-exit can never drive `active` negative
   * (which would wedge the gate permanently closed).
   */
  exitBackoff(): void {
    if (this.active === 0) return;
    this.active -= 1;
    if (this.active === 0) {
      // Splice-then-wake: clear the list before invoking, so a waiter that
      // re-parks (a window reopened in the same turn) lands on a fresh list.
      const parked = this.waiters.splice(0, this.waiters.length);
      for (const wake of parked) wake();
    }
  }

  /**
   * Resolve immediately when no window is active; otherwise park until the
   * window fully clears. Re-checks the counter after each wake so a window that
   * reopens before a woken worker resumes still holds it back (no lost wakeup:
   * {@link enterBackoff} never consumes waiters).
   */
  async waitUntilClear(): Promise<void> {
    while (this.active > 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}
