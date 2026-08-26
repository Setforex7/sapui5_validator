import { describe, expect, test } from 'vitest';
import {
  BudgetExhaustedError,
  CallBudget,
  DEFAULT_LLM_BUDGET,
  RATE_LIMIT_BACKOFF_MS,
  withRateLimitBackoff,
} from '../../src/claude/budget.js';
import { RateLimitExhaustedError } from '../../src/claude/binary-runner.js';

describe('CallBudget', () => {
  test('defaults to SPEC §2.12 budget of 50', () => {
    expect(DEFAULT_LLM_BUDGET).toBe(50);
    const b = new CallBudget();
    expect(b.maxCalls).toBe(50);
    expect(b.remaining).toBe(50);
    expect(b.callsUsed).toBe(0);
    expect(b.exhausted).toBe(false);
  });

  test('consume increments and reports remaining', () => {
    const b = new CallBudget({ maxCalls: 3 });
    b.consume();
    b.consume();
    expect(b.callsUsed).toBe(2);
    expect(b.remaining).toBe(1);
    expect(b.exhausted).toBe(false);
    b.consume();
    expect(b.exhausted).toBe(true);
    expect(b.remaining).toBe(0);
  });

  test('throws BudgetExhaustedError sentinel when over budget', () => {
    const b = new CallBudget({ maxCalls: 1 });
    b.consume();
    let caught: unknown;
    try {
      b.consume();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof BudgetExhaustedError) {
      expect(caught.budget).toBe(1);
      expect(caught.callsAttempted).toBe(2);
      expect(caught.name).toBe('BudgetExhaustedError');
    }
  });

  test('instanceof check works across realms (sentinel, not string-match)', () => {
    const err = new BudgetExhaustedError(5, 3);
    expect(err instanceof BudgetExhaustedError).toBe(true);
    // Subclassing-friendly: prototype chain points back to BudgetExhaustedError.
    expect(Object.getPrototypeOf(err)).toBe(BudgetExhaustedError.prototype);
  });

  test('rejects negative or non-integer budget', () => {
    expect(() => new CallBudget({ maxCalls: -1 })).toThrow();
    expect(() => new CallBudget({ maxCalls: 1.5 })).toThrow();
  });

  test('maxCalls=0 throws on first consume', () => {
    const b = new CallBudget({ maxCalls: 0 });
    expect(() => b.consume()).toThrow(BudgetExhaustedError);
  });
});

describe('RATE_LIMIT_BACKOFF_MS', () => {
  test('is the SPEC §2.12 schedule 1s / 4s / 16s', () => {
    expect([...RATE_LIMIT_BACKOFF_MS]).toEqual([1000, 4000, 16000]);
  });
});

describe('withRateLimitBackoff', () => {
  test('returns first non-rate-limited result without sleeping', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRateLimitBackoff(
      async () => {
        calls += 1;
        return 'ok';
      },
      {
        isRateLimited: (r) => r === 'rate-limited',
        sleeper: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('retries with the configured delays in order on rate-limited result', async () => {
    const sleeps: number[] = [];
    const responses = ['rl', 'rl', 'rl', 'ok'];
    let i = 0;
    const result = await withRateLimitBackoff(
      async () => {
        const value = responses[i] ?? 'ok';
        i += 1;
        return value;
      },
      {
        isRateLimited: (r) => r === 'rl',
        sleeper: async (ms) => {
          sleeps.push(ms);
        },
        delays: [10, 20, 30],
      },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([10, 20, 30]);
    expect(i).toBe(4);
  });

  test('returns final still-rate-limited result after exhausting delays', async () => {
    const sleeps: number[] = [];
    const result = await withRateLimitBackoff(
      async () => 'rl',
      {
        isRateLimited: (r) => r === 'rl',
        sleeper: async (ms) => {
          sleeps.push(ms);
        },
        delays: [10, 20],
      },
    );
    expect(result).toBe('rl');
    expect(sleeps).toEqual([10, 20]);
  });

  // --- V1.2-3: throwOnExhaustion opt-in ---

  test('throwOnExhaustion: throws RateLimitExhaustedError when final attempt is still rate-limited', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let caught: unknown;
    try {
      await withRateLimitBackoff(
        async () => {
          attempts += 1;
          return 'rl';
        },
        {
          isRateLimited: (r) => r === 'rl',
          sleeper: async (ms) => {
            sleeps.push(ms);
          },
          delays: [10, 20, 30],
          throwOnExhaustion: () =>
            new RateLimitExhaustedError('cid-final', 4, 'still rate limited'),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitExhaustedError);
    if (caught instanceof RateLimitExhaustedError) {
      expect(caught.callId).toBe('cid-final');
      expect(caught.attemptsBeforeFailure).toBe(4);
      expect(caught.lastAttemptDetail).toBe('still rate limited');
    }
    // Initial call + one call per delay = 4 attempts.
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([10, 20, 30]);
  });

  test('throwOnExhaustion: does NOT throw when rate limit clears on the last retry', async () => {
    const responses = ['rl', 'rl', 'ok'];
    let i = 0;
    const result = await withRateLimitBackoff(
      async () => {
        const v = responses[i] ?? 'ok';
        i += 1;
        return v;
      },
      {
        isRateLimited: (r) => r === 'rl',
        sleeper: async () => {},
        delays: [10, 20],
        throwOnExhaustion: () => new RateLimitExhaustedError('c', 3, 'should not throw'),
      },
    );
    expect(result).toBe('ok');
  });

  test('throwOnExhaustion: does NOT throw when rate limit clears on attempt 2 (mid-schedule)', async () => {
    const responses = ['rl', 'ok'];
    let i = 0;
    const result = await withRateLimitBackoff(
      async () => {
        const v = responses[i] ?? 'ok';
        i += 1;
        return v;
      },
      {
        isRateLimited: (r) => r === 'rl',
        sleeper: async () => {},
        delays: [10, 20, 30],
        throwOnExhaustion: () => new RateLimitExhaustedError('c', 4, 'should not throw'),
      },
    );
    expect(result).toBe('ok');
  });

  test('throwOnExhaustion: not invoked when option is absent (legacy return-on-exhaustion path)', async () => {
    const result = await withRateLimitBackoff(
      async () => 'rl',
      {
        isRateLimited: (r) => r === 'rl',
        sleeper: async () => {},
        delays: [10],
        // throwOnExhaustion intentionally omitted — preserves the
        // src/generation/retry-loop.ts behaviour (V1.3+ backlog).
      },
    );
    expect(result).toBe('rl');
  });

  // --- V1.5 (D1): isRateLimitedError / throwOnExhaustionError (thrown-error path) ---

  class FakeRateLimitError extends Error {}

  test('isRateLimitedError: retries a thrown rate-limit error, then returns the eventual result', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await withRateLimitBackoff(
      async () => {
        attempts += 1;
        if (attempts <= 2) throw new FakeRateLimitError('429');
        return 'ok';
      },
      {
        isRateLimited: (r) => r === 'rl',
        isRateLimitedError: (err) => err instanceof FakeRateLimitError,
        sleeper: async (ms) => {
          sleeps.push(ms);
        },
        delays: [10, 20, 30],
      },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test('throwOnExhaustionError: builds the terminal error when the schedule exhausts on a persistent throw', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    let caught: unknown;
    try {
      await withRateLimitBackoff(
        async () => {
          attempts += 1;
          throw new FakeRateLimitError('429');
        },
        {
          isRateLimited: (r) => r === 'rl',
          isRateLimitedError: (err) => err instanceof FakeRateLimitError,
          throwOnExhaustionError: () =>
            new RateLimitExhaustedError('cid-thrown', 4, 'persistent 429'),
          sleeper: async (ms) => {
            sleeps.push(ms);
          },
          delays: [10, 20, 30],
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitExhaustedError);
    if (caught instanceof RateLimitExhaustedError) {
      expect(caught.callId).toBe('cid-thrown');
      expect(caught.lastAttemptDetail).toBe('persistent 429');
    }
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([10, 20, 30]);
  });

  test('throwOnExhaustionError absent: re-throws the last thrown rate-limit error unchanged', async () => {
    const sentinel = new FakeRateLimitError('still 429');
    let caught: unknown;
    try {
      await withRateLimitBackoff(
        async () => {
          throw sentinel;
        },
        {
          isRateLimited: (r) => r === 'rl',
          isRateLimitedError: (err) => err instanceof FakeRateLimitError,
          sleeper: async () => {},
          delays: [10],
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(sentinel);
  });

  test('a non-rate-limit throw propagates immediately, with no retry or sleep', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const boom = new Error('boom');
    let caught: unknown;
    try {
      await withRateLimitBackoff(
        async () => {
          attempts += 1;
          throw boom;
        },
        {
          isRateLimited: (r) => r === 'rl',
          isRateLimitedError: (err) => err instanceof FakeRateLimitError,
          sleeper: async (ms) => {
            sleeps.push(ms);
          },
          delays: [10, 20],
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
