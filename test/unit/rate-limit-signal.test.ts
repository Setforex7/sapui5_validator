/**
 * THR-4 (V1.9.7) — the pool-wide rate-limit signal and its wiring into the
 * per-call backoff schedule.
 *
 * Two seams are pinned here, independently of the concurrent `generate` pool
 * (that composition is proven end-to-end in `test/integration/generate.test.ts`
 * → "runGenerate — V1.9.7 THR-4 pool-wide rate-limit backoff"):
 *
 *   1. {@link RateLimitSignal} — the counter + parked-waiter gate: it opens/
 *      closes on enter/exit, counts nested windows, wakes every parked waiter
 *      when the last window clears, and never underflows on a stray exit.
 *   2. {@link withRateLimitBackoff} + a signal — the schedule enters the window
 *      exactly once (on the first backoff) and exits exactly once on EVERY exit
 *      path (recovered, exhausted-result, exhausted-throw), the last being the
 *      deadlock-freedom guarantee the pool relies on. A schedule that never
 *      backs off never touches the signal.
 */

import { describe, expect, test } from 'vitest';
import {
  RateLimitSignal,
} from '../../src/claude/rate-limit-signal.js';
import {
  RATE_LIMIT_BACKOFF_MS,
  withRateLimitBackoff,
  type Sleeper,
} from '../../src/claude/budget.js';

/** Flush the microtask queue by hopping the macrotask boundary. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An instant sleeper that records the delays it was asked to wait. */
function recordingSleeper(): { sleeper: Sleeper; slept: number[] } {
  const slept: number[] = [];
  return { slept, sleeper: async (ms) => void slept.push(ms) };
}

/** A signal that counts enter/exit calls while keeping the real gate behaviour. */
class RecordingSignal extends RateLimitSignal {
  enters = 0;
  exits = 0;
  override enterBackoff(): void {
    this.enters += 1;
    super.enterBackoff();
  }
  override exitBackoff(): void {
    this.exits += 1;
    super.exitBackoff();
  }
}

describe('RateLimitSignal — gate semantics', () => {
  test('starts open — waitUntilClear resolves immediately when no window is active', async () => {
    const sig = new RateLimitSignal();
    expect(sig.backingOff).toBe(false);
    let cleared = false;
    await sig.waitUntilClear().then(() => {
      cleared = true;
    });
    expect(cleared).toBe(true);
  });

  test('enterBackoff closes the gate; a waiter parks until exitBackoff reopens it', async () => {
    const sig = new RateLimitSignal();
    sig.enterBackoff();
    expect(sig.backingOff).toBe(true);

    let released = false;
    void sig.waitUntilClear().then(() => {
      released = true;
    });
    await tick();
    // The window is still open, so the waiter must not have resolved.
    expect(released).toBe(false);

    sig.exitBackoff();
    expect(sig.backingOff).toBe(false);
    await tick();
    expect(released).toBe(true);
  });

  test('nested windows count — the gate reopens only when the LAST window clears', async () => {
    const sig = new RateLimitSignal();
    sig.enterBackoff();
    sig.enterBackoff(); // two workers backing off at once
    expect(sig.backingOff).toBe(true);

    let released = false;
    void sig.waitUntilClear().then(() => {
      released = true;
    });

    sig.exitBackoff(); // one down, one still active
    await tick();
    expect(sig.backingOff).toBe(true);
    expect(released).toBe(false);

    sig.exitBackoff(); // last one clears
    await tick();
    expect(sig.backingOff).toBe(false);
    expect(released).toBe(true);
  });

  test('every parked waiter is woken when the window clears', async () => {
    const sig = new RateLimitSignal();
    sig.enterBackoff();
    const woken: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      void sig.waitUntilClear().then(() => woken.push(i));
    }
    await tick();
    expect(woken).toEqual([]);
    sig.exitBackoff();
    await tick();
    expect(woken.sort()).toEqual([0, 1, 2]);
  });

  test('exitBackoff never underflows — a stray exit on an open gate is a no-op', async () => {
    const sig = new RateLimitSignal();
    sig.exitBackoff(); // stray — must NOT drive the counter negative
    expect(sig.backingOff).toBe(false);
    // If the counter had gone to -1, this single enter would leave it at 0 and
    // the gate would (wrongly) read open; assert it actually closes.
    sig.enterBackoff();
    expect(sig.backingOff).toBe(true);
    let released = false;
    void sig.waitUntilClear().then(() => {
      released = true;
    });
    await tick();
    expect(released).toBe(false);
    sig.exitBackoff();
    await tick();
    expect(released).toBe(true);
  });
});

describe('withRateLimitBackoff — signal enter/exit wiring', () => {
  const isRL = (r: string): boolean => r === 'RL';

  test('a schedule that never backs off never touches the signal', async () => {
    const sig = new RecordingSignal();
    const { sleeper, slept } = recordingSleeper();
    const out = await withRateLimitBackoff(async () => 'ok', {
      isRateLimited: isRL,
      sleeper,
      signal: sig,
    });
    expect(out).toBe('ok');
    expect(slept).toEqual([]);
    expect(sig.enters).toBe(0);
    expect(sig.exits).toBe(0);
    expect(sig.backingOff).toBe(false);
  });

  test('a transient rate-limit enters once and exits once, then the gate is open', async () => {
    const sig = new RecordingSignal();
    const { sleeper, slept } = recordingSleeper();
    let calls = 0;
    const out = await withRateLimitBackoff(
      async () => {
        calls += 1;
        return calls === 1 ? 'RL' : 'ok';
      },
      { isRateLimited: isRL, sleeper, signal: sig },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(2);
    // Exactly one backoff sleep with the schedule's first delay.
    expect(slept).toEqual([RATE_LIMIT_BACKOFF_MS[0]]);
    // Entered once (first sleep), exited once (recovery), gate now open.
    expect(sig.enters).toBe(1);
    expect(sig.exits).toBe(1);
    expect(sig.backingOff).toBe(false);
  });

  test('a persistent rate-limit RESULT exits the window before throwOnExhaustion fires', async () => {
    const sig = new RecordingSignal();
    const { sleeper, slept } = recordingSleeper();
    const sentinel = new Error('exhausted');
    await expect(
      withRateLimitBackoff(async () => 'RL', {
        isRateLimited: isRL,
        sleeper,
        signal: sig,
        throwOnExhaustion: () => sentinel as never,
      }),
    ).rejects.toBe(sentinel);
    // Full schedule honoured, entered once, exited once via the finally.
    expect(slept).toEqual([...RATE_LIMIT_BACKOFF_MS]);
    expect(sig.enters).toBe(1);
    expect(sig.exits).toBe(1);
    expect(sig.backingOff).toBe(false);
  });

  test('a persistent thrown rate-limit error exits the window before it propagates', async () => {
    const sig = new RecordingSignal();
    const { sleeper } = recordingSleeper();
    const thrown = new Error('429 too many requests');
    const terminal = new Error('terminal');
    await expect(
      withRateLimitBackoff(
        async () => {
          throw thrown;
        },
        {
          isRateLimited: isRL,
          sleeper,
          signal: sig,
          isRateLimitedError: (e) => e === thrown,
          throwOnExhaustionError: () => terminal as never,
        },
      ),
    ).rejects.toBe(terminal);
    // The finally reopened the window even though the schedule ended by throwing
    // — this is the deadlock-freedom guarantee the concurrent pool relies on.
    expect(sig.enters).toBe(1);
    expect(sig.exits).toBe(1);
    expect(sig.backingOff).toBe(false);
  });

  test('a non-rate-limit throw propagates immediately and never touches the signal', async () => {
    const sig = new RecordingSignal();
    const { sleeper } = recordingSleeper();
    const boom = new Error('auth failure');
    await expect(
      withRateLimitBackoff(
        async () => {
          throw boom;
        },
        { isRateLimited: isRL, sleeper, signal: sig },
      ),
    ).rejects.toBe(boom);
    expect(sig.enters).toBe(0);
    expect(sig.exits).toBe(0);
    expect(sig.backingOff).toBe(false);
  });
});
