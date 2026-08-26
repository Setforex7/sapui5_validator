/**
 * V1.6 — unit coverage for `src/util/concurrency.ts`.
 *
 * The `Semaphore` underpins both the opt-in generate worker pool (degree K)
 * and the verify-lane mutex (degree 1). These tests pin the load-bearing
 * properties: it caps concurrency, never leaks a permit on throw, is FIFO,
 * and a double-release frees only one permit.
 */

import { describe, expect, test } from 'vitest';
import { Semaphore } from '../../src/util/concurrency.js';

/** Flush the microtask queue by hopping the macrotask boundary. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Semaphore — construction', () => {
  test('rejects a non-positive or non-integer permit count', () => {
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(-1)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
  });

  test('accepts a positive integer', () => {
    expect(() => new Semaphore(1)).not.toThrow();
    expect(() => new Semaphore(8)).not.toThrow();
  });
});

describe('Semaphore — concurrency bound', () => {
  test('caps the number of simultaneously-running tasks at the permit count', async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];
    const make = (): Promise<void> =>
      sem.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((res) => releasers.push(res));
        inFlight -= 1;
      });

    let settled = false;
    const all = Promise.all([0, 1, 2, 3, 4].map(make)).then(() => {
      settled = true;
    });

    await tick();
    // Only the permit count may be running; the rest queue on acquire().
    expect(inFlight).toBe(2);
    expect(peak).toBe(2);
    expect(releasers).toHaveLength(2);

    // Drain one at a time; each freed permit admits exactly one waiter.
    while (!settled) {
      releasers.shift()?.();
      await tick();
    }
    await all;
    expect(peak).toBe(2);
  });

  test('degree 1 is a mutex — runs never overlap', async () => {
    const sem = new Semaphore(1);
    let inFlight = 0;
    let peak = 0;
    const releasers: Array<() => void> = [];
    const make = (): Promise<void> =>
      sem.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((res) => releasers.push(res));
        inFlight -= 1;
      });

    let settled = false;
    const all = Promise.all([0, 1, 2].map(make)).then(() => {
      settled = true;
    });

    await tick();
    expect(peak).toBe(1);
    while (!settled) {
      releasers.shift()?.();
      await tick();
    }
    await all;
    expect(peak).toBe(1);
  });
});

describe('Semaphore — permit hygiene', () => {
  test('a throwing task releases its permit (run uses finally)', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // If the permit had leaked, this second run would deadlock and the test
    // would time out instead of completing.
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test('release is idempotent — a double release frees only one permit', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    r1();
    r1(); // second call must be a no-op

    const r2 = await sem.acquire(); // takes the single permit
    let third = false;
    void sem.acquire().then(() => {
      third = true;
    });
    await tick();
    // Only one real permit exists, held by r2, so the third acquire must wait.
    expect(third).toBe(false);
    r2();
    await tick();
    expect(third).toBe(true);
  });

  test('waiters are released in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const hold = await sem.acquire();

    const a = sem.acquire().then((r) => {
      order.push('A');
      return r;
    });
    const b = sem.acquire().then((r) => {
      order.push('B');
      return r;
    });
    const c = sem.acquire().then((r) => {
      order.push('C');
      return r;
    });

    hold();
    (await a)();
    await tick();
    (await b)();
    await tick();
    (await c)();
    expect(order).toEqual(['A', 'B', 'C']);
  });
});
