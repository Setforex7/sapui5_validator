/**
 * V1.6 — minimal async concurrency primitives for the `generate` worker pool
 * and the `validate` check-batch pool (SPEC §2.15 — since V1.9.7/THR-1
 * `--concurrency` defaults to 2 for both commands; `--concurrency 1` restores
 * the sequential V1 contract). Hand-rolled to avoid a new runtime dependency
 * (SPEC §5 / CLAUDE.md "New dependencies").
 *
 * A single counting `Semaphore` serves two production callers, which is what
 * justifies the abstraction (CLAUDE.md — extract on the second caller):
 *
 *   1. As the **worker-pool bound** (degree K) it caps how many per-candidate
 *      generate+verify cycles — and therefore how many concurrent `claude -p`
 *      calls — run at once. That bound IS the shared client-side LLM
 *      concurrency limiter the V1.6 plan calls for (the "global semaphore").
 *   2. At degree 1 it is the **verify lane** mutex: it serialises the
 *      register→verify→accept critical section so two workers never have a
 *      test registered-but-unverified in the project's shared karma suite at
 *      the same time. Without it, worker A's whole-suite karma run would
 *      execute worker B's not-yet-verified (possibly failing) test and quarantine
 *      a sound test A — a verify-then-accept (SPEC §1.2) violation.
 *
 * FIFO: waiters are released in arrival order, so the pool makes fair progress
 * and a starvation regression cannot hide behind LIFO ordering in tests.
 */

export type SemaphoreRelease = () => void;

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(
        `Semaphore permits must be a positive integer, got: ${String(permits)}`,
      );
    }
    this.available = permits;
  }

  /**
   * Acquire one permit. Resolves immediately when a permit is free, otherwise
   * once a prior holder releases (FIFO). The returned release function is
   * idempotent — calling it more than once frees only one permit.
   */
  async acquire(): Promise<SemaphoreRelease> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // A permit was handed directly to us by release() (it did NOT increment
    // `available`), so we own it without decrementing again.
    return this.makeRelease();
  }

  /**
   * Run `fn` while holding one permit; release in a `finally` so a throw never
   * leaks a permit (which would wedge the pool / lane forever).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) {
        // Transfer the permit directly to the next waiter — do NOT increment
        // `available`, or a double permit would escape.
        next();
      } else {
        this.available += 1;
      }
    };
  }
}
