import { RateLimitExhaustedError } from './binary-runner.js';
import type { RateLimitSignal } from './rate-limit-signal.js';

export const DEFAULT_LLM_BUDGET = 50;

export const RATE_LIMIT_BACKOFF_MS: readonly number[] = Object.freeze([1000, 4000, 16000]);

export class BudgetExhaustedError extends Error {
  readonly callsAttempted: number;
  readonly budget: number;

  constructor(callsAttempted: number, budget: number) {
    // V1.2-4: accessible "budget was reached" framing + concrete next-step
    // flags (--max-llm-calls, --per-check-cap, narrow scope) up front; the
    // raw "<a> of <b>" counts stay in the message so power users still see
    // them on stderr and so the audit log captures them in `.message`.
    super(
      `The LLM call budget was reached (attempted ${callsAttempted} of ${budget}). ` +
        `Increase --max-llm-calls, raise --per-check-cap, or narrow the scope ` +
        `(e.g. validate a single file) and re-run.`,
    );
    this.name = 'BudgetExhaustedError';
    this.callsAttempted = callsAttempted;
    this.budget = budget;
    Object.setPrototypeOf(this, BudgetExhaustedError.prototype);
  }
}

export interface BudgetOptions {
  readonly maxCalls: number;
}

export class CallBudget {
  readonly maxCalls: number;
  private callCount = 0;

  constructor(options: BudgetOptions = { maxCalls: DEFAULT_LLM_BUDGET }) {
    if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0) {
      throw new Error(`maxCalls must be a non-negative integer, got: ${String(options.maxCalls)}`);
    }
    this.maxCalls = options.maxCalls;
  }

  get callsUsed(): number {
    return this.callCount;
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.callCount);
  }

  get exhausted(): boolean {
    return this.callCount >= this.maxCalls;
  }

  consume(): void {
    if (this.callCount >= this.maxCalls) {
      throw new BudgetExhaustedError(this.callCount + 1, this.maxCalls);
    }
    this.callCount += 1;
  }
}

export type Sleeper = (ms: number) => Promise<void>;

export const defaultSleeper: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface BackoffOptions<T> {
  readonly isRateLimited: (result: T) => boolean;
  readonly delays?: readonly number[];
  readonly sleeper?: Sleeper;
  /**
   * V1.2-3 opt-in: callback that converts the final still-rate-limited result
   * into a {@link RateLimitExhaustedError} which is thrown instead of being
   * returned to the caller. Validate's check + refinement call sites pass
   * this so a hot rate-limit window short-circuits the orchestrator into the
   * dedicated `{ kind: 'rate-limited' }` exit reason. Callers that leave it
   * unset (e.g. `src/generation/retry-loop.ts`, deferred to V1.3+) keep the
   * legacy "return the rate-limited result" semantics.
   */
  readonly throwOnExhaustion?: (result: T) => RateLimitExhaustedError;
  /**
   * V1.5 (D1) — classify a THROWN error as rate-limit-shaped (e.g. a 429
   * `ClaudeApiError`). The real `claude -p` CLI signals a quota cap with an
   * `is_error` envelope that `BinaryRunner` surfaces as a *thrown*
   * `ClaudeApiError`, not a returned result — so without this predicate the
   * SPEC §2.12 backoff schedule was bypassed entirely for the canonical 429.
   * When set and `fn()` throws a matching error, the schedule retries the
   * throw exactly as it retries a rate-limited result. A non-matching throw
   * (or any throw when this is unset) propagates immediately, preserving the
   * prior behaviour for auth / max-turns / malformed errors.
   */
  readonly isRateLimitedError?: (err: unknown) => boolean;
  /**
   * V1.5 (D1) — build the terminal {@link RateLimitExhaustedError} when the
   * schedule is exhausted and the final attempt THREW a rate-limit error (the
   * thrown-error analogue of `throwOnExhaustion`). When unset, the last
   * matching thrown error is re-thrown unchanged.
   */
  readonly throwOnExhaustionError?: (err: unknown) => RateLimitExhaustedError;
  /**
   * THR-4 (V1.9.7) — the pool-wide rate-limit signal (see
   * `claude/rate-limit-signal.ts`). When set, the schedule calls
   * {@link RateLimitSignal.enterBackoff} once — the first time it backs off on a
   * 429 — and {@link RateLimitSignal.exitBackoff} exactly once when the schedule
   * resolves (recovered, exhausted, or a non-rate-limit throw surfacing
   * mid-schedule), via a `finally`. The concurrent `generate` pool consumes this
   * to drain new dispatches while any worker is in a backoff window. Unset (the
   * sequential path and every non-pooled call site) leaves the schedule
   * byte-identical to before — a single worker gains nothing from signalling
   * itself.
   */
  readonly signal?: RateLimitSignal;
}

/**
 * Run `fn` and, while the outcome is classified as rate-limited, retry after
 * each successive backoff delay (SPEC §2.12: 1s / 4s / 16s for the default
 * 3-attempt schedule). A rate-limited *result* (via `isRateLimited`) and a
 * thrown rate-limit *error* (via `isRateLimitedError`) are treated identically
 * — both are retried; a non-rate-limit throw propagates immediately. When the
 * schedule is exhausted:
 *
 *   - if the final attempt threw a rate-limit error: throw
 *     `throwOnExhaustionError(err)` when set, else re-throw the error;
 *   - if `throwOnExhaustion` is set and the final result is still
 *     rate-limited, throw the {@link RateLimitExhaustedError} it builds
 *     (V1.2-3 — run-terminating signal for the validate orchestrator);
 *   - otherwise return the final result regardless of whether it is still
 *     rate-limited so the caller can decide how to surface it (preserved for
 *     the unit-test "return last result" scenarios).
 */
export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  options: BackoffOptions<T>,
): Promise<T> {
  const sleeper = options.sleeper ?? defaultSleeper;
  const delays = options.delays ?? RATE_LIMIT_BACKOFF_MS;
  const isRateLimitedError = options.isRateLimitedError ?? (() => false);
  // THR-4 (V1.9.7): the pool-wide backoff window. Entered once (on the first
  // sleep) and exited exactly once (in `finally`, on every exit path) so the
  // concurrent pool can drain new dispatches while this schedule is hot without
  // ever deadlocking on a schedule that already ended. Unset ⇒ every branch
  // below is byte-identical to the pre-THR-4 behaviour.
  const signal = options.signal;
  let enteredBackoff = false;

  // Each attempt yields either a result or a *retryable* rate-limit error; a
  // non-rate-limit throw propagates immediately (legacy behaviour).
  type Attempt =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  const attempt = async (): Promise<Attempt> => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (isRateLimitedError(err)) return { ok: false, error: err };
      throw err;
    }
  };

  try {
    let outcome = await attempt();
    for (const delay of delays) {
      if (outcome.ok && !options.isRateLimited(outcome.value)) return outcome.value;
      // Reaching a sleep means the current outcome IS rate-limited. THR-4: close
      // the shared pool window once, on the first backoff, so peer workers stop
      // dispatching NEW candidates until this schedule resolves.
      if (signal !== undefined && !enteredBackoff) {
        signal.enterBackoff();
        enteredBackoff = true;
      }
      await sleeper(delay);
      outcome = await attempt();
    }

    if (!outcome.ok) {
      if (options.throwOnExhaustionError !== undefined) {
        throw options.throwOnExhaustionError(outcome.error);
      }
      throw outcome.error;
    }
    if (options.throwOnExhaustion !== undefined && options.isRateLimited(outcome.value)) {
      throw options.throwOnExhaustion(outcome.value);
    }
    return outcome.value;
  } finally {
    // THR-4: reopen the shared window on EVERY exit path (recovered, exhausted,
    // or a non-rate-limit throw that surfaced mid-schedule) so a parked pool
    // worker never waits on a window that already ended. (`enteredBackoff` ⇒
    // `signal` was defined; the extra guard keeps the strict null-check happy
    // without a non-null assertion.)
    if (enteredBackoff && signal !== undefined) {
      signal.exitBackoff();
    }
  }
}
