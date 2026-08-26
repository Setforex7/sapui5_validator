import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { exec, type ExecOptions, type ExecResult } from '../util/exec.js';
import { assertInsideProject } from '../util/containment.js';
import { extractJsonValue, JsonExtractionError } from '../util/json-envelope.js';
import { RATE_LIMIT_SIGNAL_RE } from './rate-limit-signal.js';
import type { ClaudeRunArgs, ClaudeRunResult, ClaudeRunner, ClaudeUsage } from './runner.js';

export class MalformedLlmOutputError extends Error {
  readonly callId: string;
  readonly errorFilePath: string;

  constructor(callId: string, errorFilePath: string) {
    // V1.2-4: user-friendly accessible explanation first, then the next
    // action, then the technical reference (path + call id) in parentheses
    // so the audit log and `--verbose` consumers still have it inline.
    super(
      `Claude returned output that could not be parsed after one reformat retry. ` +
        `The raw response was saved for inspection at ${errorFilePath}. ` +
        `(call ${callId})`,
    );
    this.name = 'MalformedLlmOutputError';
    this.callId = callId;
    this.errorFilePath = errorFilePath;
    Object.setPrototypeOf(this, MalformedLlmOutputError.prototype);
  }
}

/**
 * TR-2 (V1.9.6) — the `claude -p --output-format json` OUTER envelope parsed as
 * JSON but did NOT match {@link claudeEnvelopeSchema}: the CLI returned a
 * well-formed body of the wrong SHAPE (missing / mistyped
 * `type`/`subtype`/`is_error`/`result`). This is a CLI-contract drift — a
 * `claude` version whose envelope shape this tool has not been validated
 * against — NOT the model producing malformed content INSIDE `result` (that
 * stays {@link MalformedLlmOutputError} + the reformat retry). Reformatting the
 * PROMPT cannot change the CLI's own envelope, so `run` deliberately skips the
 * retry — the same rationale as the process-kill and rate-limit-signal skips.
 * Surfaced as a distinct exit reason (`envelope-contract-mismatch`) so the user
 * reads "your claude CLI is incompatible" rather than "this tool is broken".
 * The pinned CLI version is named at the EXIT layer, not here: the orchestrator
 * has it from the availability probe, so the runner stays version-agnostic
 * behind the SPEC §1.5 seam.
 */
export class ClaudeEnvelopeContractError extends Error {
  readonly callId: string;
  readonly errorFilePath: string;
  /** The zod shape-mismatch detail (also written to the on-disk dump). */
  readonly detail: string;

  constructor(callId: string, detail: string, errorFilePath: string) {
    super(
      `The claude CLI returned a response whose envelope shape does not match the ` +
        `expected contract (${detail}). This usually means the installed claude CLI ` +
        `is a version this tool has not been validated against. The raw response was ` +
        `saved for inspection at ${errorFilePath}. (call ${callId})`,
    );
    this.name = 'ClaudeEnvelopeContractError';
    this.callId = callId;
    this.detail = detail;
    this.errorFilePath = errorFilePath;
    Object.setPrototypeOf(this, ClaudeEnvelopeContractError.prototype);
  }
}

/**
 * The `claude` subprocess terminated before producing output — exit code is
 * negative (killed by signal / Windows "killed" classification) or non-zero
 * with empty stdout. This is distinct from {@link MalformedLlmOutputError}:
 * there is no output to reformat, so the reformat retry is deliberately
 * skipped (V1.1-DIAGNOSIS.md §"Bug 2", §"Bug 6").
 */
export class ClaudeProcessKilledError extends Error {
  readonly callId: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly errorFilePath: string;

  constructor(callId: string, exitCode: number, stderr: string, errorFilePath: string) {
    // V1.2-4: lead with the accessible "process exited before output"
    // framing; suggest the usual cause (system kill / interrupt); keep the
    // exit code and saved-path reference in the technical parenthetical.
    super(
      `The Claude process exited before producing output (exit code ${exitCode}). ` +
        `This usually means the process was killed by the system ` +
        `(out of memory, signal, or shell interrupt). ` +
        `See the saved details at ${errorFilePath}. (call ${callId})`,
    );
    this.name = 'ClaudeProcessKilledError';
    this.callId = callId;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.errorFilePath = errorFilePath;
    Object.setPrototypeOf(this, ClaudeProcessKilledError.prototype);
  }
}

/**
 * V1.2-3: the SPEC §2.12 rate-limit backoff schedule (1s / 4s / 16s, 3
 * attempts) was exhausted and every attempt still classified as rate-limited.
 * Distinct from {@link ClaudeApiError} — that error is per-call (a single
 * envelope reporting a rate-limit), while this error is per-backoff-schedule
 * (the schedule itself gave up). Distinct in intent too: a thrown
 * `RateLimitExhaustedError` is a run-terminating signal that the user's plan
 * window is hot, not a per-finding failure to convert into a Finding. The
 * orchestrator catches it and exits with `{ kind: 'rate-limited' }` instead
 * of letting it propagate as an unhandled error.
 *
 * `attemptsBeforeFailure` includes the first call plus every backoff retry,
 * so it matches `RATE_LIMIT_BACKOFF_MS.length + 1` for the default schedule.
 */
export class RateLimitExhaustedError extends Error {
  readonly callId: string;
  readonly attemptsBeforeFailure: number;
  readonly lastAttemptDetail: string;

  constructor(
    callId: string,
    attemptsBeforeFailure: number,
    lastAttemptDetail: string,
  ) {
    // V1.2-4: accessible explanation (rate limit + retries did not recover)
    // and the concrete next action (wait for the window) come first; the
    // call id, attempt count, and last-attempt detail are retained in the
    // technical parenthetical because the existing binary-runner.test.ts
    // assertions (cid-, "<N> attempts", "<lastDetail>") rely on them and
    // because the audit log writes `.message` verbatim.
    super(
      `Claude's rate limit was hit and the backoff retries did not recover. ` +
        `Wait for the rate limit window to reset (typically 5 minutes) and re-run; ` +
        `partial results are saved. ` +
        `(call ${callId}, ${attemptsBeforeFailure} attempts; last attempt: ${lastAttemptDetail})`,
    );
    this.name = 'RateLimitExhaustedError';
    this.callId = callId;
    this.attemptsBeforeFailure = attemptsBeforeFailure;
    this.lastAttemptDetail = lastAttemptDetail;
    Object.setPrototypeOf(this, RateLimitExhaustedError.prototype);
  }
}

/**
 * The `claude` subprocess produced a well-formed `--output-format json`
 * envelope, but the envelope reports a non-success outcome: `is_error: true`
 * (auth failure, rate limit, tool error, …) or a non-`success` `subtype`
 * (e.g. `error_max_turns`). Distinct from {@link MalformedLlmOutputError} —
 * the transport succeeded and the envelope parsed cleanly; it is the API call
 * *inside* the CLI that failed. The reformat retry is skipped: re-prompting
 * cannot recover an auth or quota failure (V1.1-DIAGNOSIS.md §"Bug 3").
 */
export class ClaudeApiError extends Error {
  readonly callId: string;
  readonly subtype: string;
  readonly isError: boolean;
  readonly apiErrorStatus: string | null;
  /** The envelope's `result` string — carries the CLI's error message. */
  readonly result: string;
  readonly errorFilePath: string;

  constructor(
    callId: string,
    subtype: string,
    isError: boolean,
    apiErrorStatus: string | null,
    result: string,
    errorFilePath: string,
  ) {
    // V1.2-4: lead with the user-facing framing (API error → check auth /
    // rate / service) and the saved-detail pointer; keep the technical
    // envelope fields (subtype, api_error_status, call id) in the
    // parenthetical so debuggers and the audit log retain them.
    const fields =
      apiErrorStatus !== null
        ? `call ${callId}, subtype "${subtype}", api_error_status "${apiErrorStatus}"`
        : `call ${callId}, subtype "${subtype}"`;
    super(
      `Claude reported an API error and could not complete the call. ` +
        `This usually indicates an authentication problem, rate limit, or upstream service issue. ` +
        `See the saved error detail at ${errorFilePath}. (${fields})`,
    );
    this.name = 'ClaudeApiError';
    this.callId = callId;
    this.subtype = subtype;
    this.isError = isError;
    this.apiErrorStatus = apiErrorStatus;
    this.result = result;
    this.errorFilePath = errorFilePath;
    Object.setPrototypeOf(this, ClaudeApiError.prototype);
  }
}

export const DEFAULT_REFORMAT_SUFFIX =
  '\n\nReturn ONLY valid JSON. No prose, no explanations, no markdown fences. The response body must be a single JSON value.';

/**
 * B1 (V1.5) — argv ceiling for the residual, flags-only command line. The
 * Windows `CreateProcess` command line is capped at 32_767 **UTF-16 code units**
 * (WCHARs), NOT bytes (COR-12); we budget below it (a 267-unit launch margin).
 *
 * TR-1 (V1.9.6): the prompt moved to stdin, so the argv this bounds now carries
 * FLAGS ONLY (tools + optional `--system-prompt`/`--model`) — small and
 * near-constant. The guard is therefore a cheap invariant expected never to fire
 * (see {@link BinaryRunner.invokeClaude}); it is retained as fail-closed defense
 * so an oversized flag payload still fails fast with an accurate error rather
 * than an OS-killed spawn mis-reported as an oversized / vendor file. Applied
 * uniformly on every platform (POSIX's byte-denominated `ARG_MAX` is far larger,
 * so a code-unit budget this small never under-counts there).
 */
export const CLAUDE_ARGV_LIMIT = 32_500;

/** Synthetic exit code stamped on the pre-spawn argv-overflow guard (no spawn happened). */
const ARGV_OVERFLOW_EXIT = -2;

export interface BinaryRunnerOptions {
  /** Path or name of the `claude` binary. Default: `claude`. */
  readonly binary?: string;
  /** Directory where `llm-error-<callId>.txt` is written when both attempts fail. */
  readonly errorOutputDir: string;
  /**
   * v0.8.1 V1: when set, every error-dump write asserts `errorOutputDir` is
   * really inside this root (realpath-based, `assertInsideProject`) — closes
   * the committed-symlink-at-`.sapui5-validator/` redirect. The CLI always
   * passes the project root; omit only when `errorOutputDir` is not a
   * project path (test scratch dirs).
   */
  readonly containmentRoot?: string;
  /** Inject a custom exec implementation (used by tests). */
  readonly execImpl?: typeof exec;
  /** Inject a deterministic call-id factory (used by tests). */
  readonly callIdFactory?: () => string;
  /** Override the reformat instruction appended on the retry attempt. */
  readonly reformatPromptSuffix?: string;
}

export class BinaryRunner implements ClaudeRunner {
  private readonly binary: string;
  private readonly errorOutputDir: string;
  private readonly containmentRoot: string | undefined;
  private readonly execImpl: typeof exec;
  private readonly callIdFactory: () => string;
  private readonly reformatSuffix: string;

  constructor(options: BinaryRunnerOptions) {
    this.binary = options.binary ?? 'claude';
    this.errorOutputDir = options.errorOutputDir;
    this.containmentRoot = options.containmentRoot;
    this.execImpl = options.execImpl ?? exec;
    this.callIdFactory = options.callIdFactory ?? (() => randomUUID());
    this.reformatSuffix = options.reformatPromptSuffix ?? DEFAULT_REFORMAT_SUFFIX;
  }

  /**
   * v0.8.1 V1: containment gate shared by the three `persist*` error-dump
   * writers. The dump filename is an internal callId, so asserting the
   * directory covers the full write path.
   */
  private async assertErrorDirContained(): Promise<void> {
    if (this.containmentRoot === undefined) return;
    await assertInsideProject(this.errorOutputDir, this.containmentRoot);
  }

  async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    const callId = this.callIdFactory();

    const first = await this.invokeClaude(args, args.prompt, callId);

    // Classify a killed subprocess (negative exit code, or non-zero exit with
    // empty stdout) before attempting to parse stdout. There is nothing to
    // reformat, so the retry path is skipped — retrying a dead, empty-output
    // prompt only burns budget (V1.1-DIAGNOSIS.md §"Bug 2", §"Bug 6").
    if (isProcessKill(first)) {
      const errorPath = await this.persistKillError(callId, args, first);
      throw new ClaudeProcessKilledError(callId, first.exitCode, first.stderr, errorPath);
    }

    // `claude -p --output-format json` emits a structured envelope; the model's
    // actual response lives in `envelope.result` as a string. Unwrap it here so
    // consumers keep seeing the inner payload via `safeJson(result.raw, …)`
    // (V1.1-DIAGNOSIS.md §"Bug 3").
    const firstInterp = interpretEnvelope(first.stdout);
    if (firstInterp.kind === 'api-error') {
      throw await this.toApiError(callId, args, first, firstInterp);
    }
    if (firstInterp.kind === 'success') {
      emitRecoveryWarn(firstInterp);
      return finalize(first, firstInterp, callId);
    }

    // D2 (V1.9.3): a 429 / rate limit can arrive as a NON-envelope body — plain
    // text or a truncated error page the CLI passes through, which never parses
    // into the `is_error` envelope. Left alone it falls through to the reformat
    // retry and then `MalformedLlmOutputError`, which `isRateLimitedApiError`
    // cannot classify, so `withRateLimitBackoff` skips the SPEC §2.12 schedule
    // and the run mis-reports a transient limit as an unrecoverable malformed
    // output (CHANGELOG [1.1.0] follow-up). Detecting the signal here and
    // throwing a rate-limit-classified `ClaudeApiError` routes it back onto the
    // backoff schedule, exactly like an enveloped 429. The reformat retry is
    // skipped for the same reason the process-kill path skips it (line 232): a
    // 429 will not reformat into valid JSON.
    if (hasRateLimitSignal(first)) {
      throw await this.toRateLimitBodyError(callId, args, first);
    }

    // TR-2 (V1.9.6): a contract-mismatch (valid JSON, wrong envelope shape) is
    // CLI-contract drift, not a model error. The reformat retry is skipped for
    // the same reason as the process-kill (line 233) and rate-limit (above)
    // skips: reformatting the PROMPT cannot change the CLI's own envelope. A
    // distinct, version-nameable error surfaces instead of MalformedLlmOutputError.
    if (firstInterp.kind === 'contract-mismatch') {
      const errorPath = await this.persistContractMismatch(callId, args, first, firstInterp.error);
      throw new ClaudeEnvelopeContractError(callId, firstInterp.error, errorPath);
    }

    // `retryable`: the outer body was non-JSON, or its inner payload did not
    // parse. Re-prompt once with the reformat instruction — the retry "remains
    // applicable" when the process completed but the payload is bad
    // (V1.1-DIAGNOSIS.md §"Bug 3"). An envelope-shape mismatch never reaches
    // here (handled above), so the retry is never spent on CLI drift.
    const retryPrompt = args.prompt + this.reformatSuffix;
    const second = await this.invokeClaude(args, retryPrompt, callId);
    const secondInterp = interpretEnvelope(second.stdout);
    if (secondInterp.kind === 'api-error') {
      throw await this.toApiError(callId, args, second, secondInterp);
    }
    if (secondInterp.kind === 'success') {
      emitRecoveryWarn(secondInterp);
      return finalize(second, secondInterp, callId);
    }

    // D2 (V1.9.3): the reformat retry can itself return a non-envelope 429 (the
    // first body did not carry the signal — e.g. a generic parse failure — but
    // the window went hot on the retry). Classify it as rate-limited before the
    // final malformed-output throw so backoff still engages. `first` was already
    // checked above, so only `second` can newly match here. Checked BEFORE the
    // contract-mismatch classification below (mirroring the first-attempt order,
    // lines 299/308): a transient rate limit should always prefer backoff over a
    // "CLI drift" verdict on either attempt.
    if (hasRateLimitSignal(second)) {
      throw await this.toRateLimitBodyError(callId, args, second);
    }

    // TR-2 (V1.9.6): defense-in-depth — a contract-mismatch that only surfaces
    // on the retry attempt (a non-JSON first body, then a wrong-shape second) is
    // still CLI drift, never malformed model output. Classify it distinctly
    // rather than letting it fall through to MalformedLlmOutputError below.
    if (secondInterp.kind === 'contract-mismatch') {
      const errorPath = await this.persistContractMismatch(
        callId,
        args,
        second,
        secondInterp.error,
      );
      throw new ClaudeEnvelopeContractError(callId, secondInterp.error, errorPath);
    }

    const errorPath = await this.persistError(
      callId,
      args,
      first,
      firstInterp.error,
      second,
      secondInterp.error,
    );
    throw new MalformedLlmOutputError(callId, errorPath);
  }

  private async invokeClaude(
    args: ClaudeRunArgs,
    prompt: string,
    callId: string,
  ): Promise<ExecResult> {
    const execArgs = buildClaudeExecArgs({
      tools: args.allowedTools,
      ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
    });
    // B1 (V1.5) → TR-1 residual invariant (V1.9.6): pre-spawn argv-byte guard.
    // The prompt now travels via stdin (see `opts.input` below), so the assembled
    // argv carries FLAGS ONLY — tools + optional `--system-prompt`/`--model` —
    // which is small and near-constant. This guard is therefore expected NEVER to
    // fire; it is kept as a cheap fail-closed invariant so that if some future
    // flag payload (e.g. an oversized system prompt) ever pushed the residual
    // argv past the OS process-argument ceiling, the call still fails fast and
    // deterministically rather than dying on an OS-killed spawn.
    const argvUnits = claudeArgvLength(execArgs);
    if (argvUnits > CLAUDE_ARGV_LIMIT) {
      const detail =
        `The assembled claude command line is ${argvUnits} characters, over the ` +
        `${CLAUDE_ARGV_LIMIT}-character process-argument limit, so the call was ` +
        `not sent. The prompt itself travels via stdin and is not counted here — ` +
        `this overflow is the residual flags-only argv (e.g. an oversized system ` +
        `prompt). Reduce the flag payload or split the run.`;
      const errorPath = await this.persistKillError(callId, args, {
        ok: false,
        stdout: '',
        stderr: detail,
        exitCode: ARGV_OVERFLOW_EXIT,
        durationMs: 0,
      });
      throw new ClaudeProcessKilledError(callId, ARGV_OVERFLOW_EXIT, detail, errorPath);
    }
    const opts: ExecOptions = {
      cwd: args.cwd,
      // TR-1 (V1.9.6): the transport swap. `claude -p` with no positional reads
      // the prompt from stdin (Phase 0 probe), so the full prompt — however large
      // its embedded source body — flows through the child's stdin here rather
      // than the OS-ceiling-bounded argv. Byte-for-byte the same `prompt` the
      // audit trail logs, so the audit output is unchanged (diagnosis §4 gate 3).
      input: prompt,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    };
    return this.execImpl(this.binary, execArgs, opts);
  }

  private async toApiError(
    callId: string,
    args: ClaudeRunArgs,
    result: ExecResult,
    interp: ApiErrorInterpretation,
  ): Promise<ClaudeApiError> {
    const errorPath = await this.persistApiError(callId, args, result, interp);
    return new ClaudeApiError(
      callId,
      interp.subtype,
      interp.isError,
      interp.apiErrorStatus,
      interp.result,
      errorPath,
    );
  }

  /**
   * D2 (V1.9.3): build the rate-limit-classified {@link ClaudeApiError} for a
   * NON-envelope 429 body (see the guards in {@link run}). `apiErrorStatus` is
   * set to `'429'` so {@link isRateLimitedApiError} classifies it via its fast
   * path, independent of the body text; the raw body is carried through `result`
   * so the terminal {@link RateLimitExhaustedError}'s detail and the error dump
   * stay faithful to what the CLI actually returned. The transport succeeded but
   * the payload was an unparseable limit notice, so — like {@link toApiError} —
   * the reformat retry is not attempted.
   */
  private async toRateLimitBodyError(
    callId: string,
    args: ClaudeRunArgs,
    result: ExecResult,
  ): Promise<ClaudeApiError> {
    const errorPath = await this.persistRateLimitError(callId, args, result);
    return new ClaudeApiError(
      callId,
      'rate_limited',
      true,
      '429',
      `${result.stdout}\n${result.stderr}`,
      errorPath,
    );
  }

  private async persistError(
    callId: string,
    args: ClaudeRunArgs,
    first: ExecResult,
    firstError: string,
    second: ExecResult,
    secondError: string,
  ): Promise<string> {
    await this.assertErrorDirContained();
    await mkdir(this.errorOutputDir, { recursive: true });
    const path = join(this.errorOutputDir, `llm-error-${callId}.txt`);
    const body = [
      `Call ID: ${callId}`,
      `CWD: ${args.cwd}`,
      `Prompt (first ${Math.min(args.prompt.length, 4000)} chars):`,
      args.prompt.slice(0, 4000),
      '',
      '--- Attempt 1 ---',
      `exitCode: ${first.exitCode}`,
      `parseError: ${firstError}`,
      'stdout:',
      first.stdout,
      'stderr:',
      first.stderr,
      '',
      '--- Attempt 2 (reformat retry) ---',
      `exitCode: ${second.exitCode}`,
      `parseError: ${secondError}`,
      'stdout:',
      second.stdout,
      'stderr:',
      second.stderr,
      '',
    ].join('\n');
    await writeFile(path, body, 'utf8');
    return path;
  }

  private async persistKillError(
    callId: string,
    args: ClaudeRunArgs,
    result: ExecResult,
  ): Promise<string> {
    await this.assertErrorDirContained();
    await mkdir(this.errorOutputDir, { recursive: true });
    const path = join(this.errorOutputDir, `llm-error-${callId}.txt`);
    const body = [
      '=== PROCESS KILLED (not malformed output) ===',
      'The claude subprocess terminated before producing output. The reformat',
      'retry was deliberately skipped — there is nothing to reformat.',
      '',
      `Call ID: ${callId}`,
      `CWD: ${args.cwd}`,
      `Prompt size: ${args.prompt.length} chars`,
      `Prompt (first ${Math.min(args.prompt.length, 4000)} chars):`,
      args.prompt.slice(0, 4000),
      '',
      '--- Process result ---',
      `exitCode: ${result.exitCode}`,
      `stdout (length ${result.stdout.length}):`,
      result.stdout,
      'stderr:',
      result.stderr,
      '',
    ].join('\n');
    await writeFile(path, body, 'utf8');
    return path;
  }

  /**
   * TR-2 (V1.9.6): dump for an envelope-contract mismatch. Mirrors
   * {@link persistKillError} (a single result, no reformat retry) but frames the
   * failure honestly as CLI-contract drift and carries the zod shape detail, so
   * the on-disk artifact does not read as "the model produced malformed output".
   */
  private async persistContractMismatch(
    callId: string,
    args: ClaudeRunArgs,
    result: ExecResult,
    detail: string,
  ): Promise<string> {
    await this.assertErrorDirContained();
    await mkdir(this.errorOutputDir, { recursive: true });
    const path = join(this.errorOutputDir, `llm-error-${callId}.txt`);
    const body = [
      '=== ENVELOPE CONTRACT MISMATCH (not malformed model output) ===',
      'The claude CLI returned a well-formed JSON body whose SHAPE does not match',
      'the expected `claude -p --output-format json` envelope contract. This is a',
      'CLI-version / contract drift, not the model producing bad content — so the',
      'reformat retry was deliberately skipped (reformatting the prompt cannot',
      "change the CLI's own envelope).",
      '',
      `Call ID: ${callId}`,
      `CWD: ${args.cwd}`,
      `Contract detail: ${detail}`,
      '',
      '--- Raw envelope (stdout) ---',
      `exitCode: ${result.exitCode}`,
      `stdout (length ${result.stdout.length}):`,
      result.stdout,
      'stderr:',
      result.stderr,
      '',
    ].join('\n');
    await writeFile(path, body, 'utf8');
    return path;
  }

  private async persistApiError(
    callId: string,
    args: ClaudeRunArgs,
    result: ExecResult,
    interp: ApiErrorInterpretation,
  ): Promise<string> {
    await this.assertErrorDirContained();
    await mkdir(this.errorOutputDir, { recursive: true });
    const path = join(this.errorOutputDir, `llm-error-${callId}.txt`);
    const body = [
      '=== CLAUDE API ERROR (well-formed envelope, non-success outcome) ===',
      'The claude subprocess returned a valid envelope, but the envelope',
      'reports a failed API call (is_error, or a non-success subtype). The',
      'reformat retry was skipped — re-prompting cannot recover an API error.',
      '',
      `Call ID: ${callId}`,
      `CWD: ${args.cwd}`,
      `subtype: ${interp.subtype}`,
      `is_error: ${String(interp.isError)}`,
      `api_error_status: ${interp.apiErrorStatus ?? '(none)'}`,
      `exitCode: ${result.exitCode}`,
      '',
      '--- envelope.result (error detail) ---',
      interp.result,
      '',
      '--- stderr ---',
      result.stderr,
      '',
    ].join('\n');
    await writeFile(path, body, 'utf8');
    return path;
  }

  private async persistRateLimitError(
    callId: string,
    args: ClaudeRunArgs,
    result: ExecResult,
  ): Promise<string> {
    await this.assertErrorDirContained();
    await mkdir(this.errorOutputDir, { recursive: true });
    const path = join(this.errorOutputDir, `llm-error-${callId}.txt`);
    const body = [
      '=== RATE LIMITED (non-envelope body) ===',
      'The claude subprocess returned a body carrying a rate-limit / 429 signal',
      'that did not parse into the JSON envelope. It is classified as rate-limited',
      'so the SPEC §2.12 backoff schedule retries it; the reformat retry was',
      'skipped — a rate-limit response will not reformat into valid JSON.',
      '',
      `Call ID: ${callId}`,
      `CWD: ${args.cwd}`,
      `exitCode: ${result.exitCode}`,
      `stdout (length ${result.stdout.length}):`,
      result.stdout,
      'stderr:',
      result.stderr,
      '',
    ].join('\n');
    await writeFile(path, body, 'utf8');
    return path;
  }
}

/**
 * Assemble the `claude -p` exec argv — the single source of truth for the spawn
 * ({@link BinaryRunner.invokeClaude}) and the B1 residual-argv guard.
 *
 * TR-1 (V1.9.6): the prompt is NOT in argv. `claude -p` with no positional reads
 * the prompt from stdin (proven by the Phase 0 transport probe), so the prompt
 * travels via the child's stdin (`ExecOptions.input`, set in `invokeClaude`) and
 * argv carries FLAGS ONLY. This lifts the Windows `CreateProcess` 32,767-char
 * ceiling off the prompt entirely — a large embedded source body no longer
 * inflates the command line. The residual argv (flags + tools + optional
 * `--system-prompt`/`--model`) is small and near-constant, so the B1 guard over
 * it is a cheap invariant now expected never to fire.
 */
export function buildClaudeExecArgs(input: {
  // Already-validated tool list (the SPEC §1.7 allowlist from `buildClaudeArgs`);
  // this helper only forwards it to the CLI argv, it never constructs the set.
  readonly tools: readonly string[];
  readonly systemPrompt?: string;
  // V1.9.4 PERF-17 — user-supplied model id; forwarded as `--model <model>`
  // only when set. Never a default pinned here.
  readonly model?: string;
}): string[] {
  const execArgs: string[] = [
    // `-p` with no positional → the prompt is read from stdin (TR-1).
    '-p',
    '--output-format',
    'json',
    '--allowedTools',
    input.tools.join(','),
  ];
  if (input.systemPrompt !== undefined) {
    execArgs.push('--system-prompt', input.systemPrompt);
  }
  // V1.9.4 PERF-17 — conditional, mirroring the `--system-prompt` push above:
  // with `model` unset the argv is byte-identical to today (the binary picks
  // the model → "no model ID in code" holds). Only a user-supplied id is sent.
  if (input.model !== undefined) {
    execArgs.push('--model', input.model);
  }
  return execArgs;
}

/**
 * Length of the assembled command line in **UTF-16 code units** (COR-12),
 * measured as the NUL-joined argv — a conservative proxy for the OS's
 * space-separated-with-quoting command line. UTF-16 code units (`String.length`)
 * match the Windows `CreateProcess` ceiling's unit; the previous UTF-8 byte
 * measure over-counted CJK-heavy flags (3 bytes vs 1 code unit per BMP char) and
 * could falsely refuse a legitimate, in-bounds argv. TR-1 (V1.9.6): the prompt no
 * longer contributes here — it travels via stdin — so this measures only the
 * residual flags-only argv. The B1 guard compares it against
 * {@link CLAUDE_ARGV_LIMIT}.
 */
export function claudeArgvLength(execArgs: readonly string[]): number {
  return execArgs.join('\0').length;
}

/**
 * Classify an exec result as a killed subprocess: a negative exit code
 * (signal kill on Unix / Windows "killed" classification), or a non-zero
 * exit code paired with empty stdout. A non-zero exit with non-empty stdout
 * (e.g. a quota envelope) stays on the normal parse path.
 */
function isProcessKill(result: ExecResult): boolean {
  return result.exitCode < 0 || (result.exitCode !== 0 && result.stdout.length === 0);
}

/**
 * D2 (V1.9.3): does an unparseable exec body carry a rate-limit signal across
 * either stream? Checked on the `retryable` path only (a well-formed envelope
 * reporting a 429 is already handled by {@link interpretEnvelope} → `api-error`
 * → {@link isRateLimitedApiError}). Shares {@link RATE_LIMIT_SIGNAL_RE} with the
 * check-layer classifiers so the transport boundary and the result classifier
 * recognise the same surface.
 */
function hasRateLimitSignal(result: ExecResult): boolean {
  return RATE_LIMIT_SIGNAL_RE.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * Shape of the `claude -p --output-format json` envelope. Only the fields the
 * runner acts on are typed; `.passthrough()` keeps unknown fields (cost,
 * usage, session_id, …) so a future CLI version adding fields does not break
 * parsing. Derived from the captured fixture at
 * `test/fixtures/llm-envelopes/envelope-success-simple.json`
 * (V1.1-DIAGNOSIS.md §"Bug 3").
 */
const claudeEnvelopeSchema = z
  .object({
    type: z.string(),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string(),
    // The real `claude -p` error envelope carries `api_error_status` as a
    // NUMBER (the raw HTTP status, e.g. `400`/`429`), not a string — observed
    // on a genuine `is_error:true` "Prompt is too long" 400 during the V1.9.6
    // real gate. Accept number here so such a well-formed API-error envelope
    // parses and is classified as `api-error` (a per-file ClaudeApiError,
    // line ~848), NOT rejected as a wrong-SHAPE `contract-mismatch` — which
    // would misreport a real per-call API error as global CLI-version drift and
    // fatally abort the run. Normalised to `string | null` at the api-error
    // branch below so every downstream consumer (the `'429'` rate-limit
    // fast-path, the error dump, the finding explanation) is unchanged.
    api_error_status: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

/**
 * V1.9.4 PERF-1 — the observability fields the envelope `.passthrough()`s.
 * Parsed SEPARATELY from {@link claudeEnvelopeSchema} (off the same raw `outer`
 * JSON) and ONLY on the success branch, so a present-but-mistyped usage block
 * can never flip a genuine success onto the retryable/malformed path: capture is
 * strictly additive, best-effort telemetry. Every field is optional (a future
 * CLI may omit any of them); `total_cost_usd` is nullable because it is an
 * estimate that may be null under a Max subscription (diagnosis §6). The usage
 * sub-counts are optional too — a missing one is treated as 0, never a parse
 * failure.
 */
const usageEnvelopeSchema = z
  .object({
    total_cost_usd: z.number().nullable().optional(),
    num_turns: z.number().optional(),
    session_id: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

interface ApiErrorInterpretation {
  readonly kind: 'api-error';
  readonly subtype: string;
  readonly isError: boolean;
  readonly apiErrorStatus: string | null;
  readonly result: string;
}

interface SuccessInterpretation {
  readonly kind: 'success';
  readonly inner: string;
  readonly innerJson: unknown;
  /**
   * AH1 tri-state from {@link extractJsonValue} (see
   * `src/util/json-envelope.ts`):
   *   - `undefined` — happy path: `JSON.parse(envelope.result)` succeeded
   *                    directly; no recovery ran; no WARN emitted.
   *   - `''`         — recovery ran, JSON was at offset 0, trailing prose
   *                    was discarded. WARN line: trailing-prose shape.
   *   - non-empty    — leading prose was stripped. WARN line: prose-
   *                    preamble shape, carrying byte count + head.
   */
  readonly recoveredPreamble?: string;
  /**
   * V1.9.4 PERF-1 — the additive observability extras parsed from the envelope
   * via {@link usageEnvelopeSchema} (success branch only). Each is omitted when
   * the envelope carried none.
   */
  readonly usage?: ClaudeUsage;
  readonly totalCostUsd?: number;
  readonly numTurns?: number;
  readonly sessionId?: string;
}

type EnvelopeInterpretation =
  | SuccessInterpretation
  | { readonly kind: 'retryable'; readonly error: string }
  // TR-2 (V1.9.6): the OUTER envelope parsed as JSON but failed the contract
  // schema — CLI drift, NOT a model error. `run` throws
  // {@link ClaudeEnvelopeContractError} without the reformat retry.
  | { readonly kind: 'contract-mismatch'; readonly error: string }
  | ApiErrorInterpretation;

/**
 * The four-step parse from V1.1-DIAGNOSIS.md §"Bug 3":
 *   1. `JSON.parse(stdout)` → envelope object.
 *   2. Validate the envelope shape; require `subtype === 'success'` and
 *      `!is_error`.
 *   3. `extractJsonValue(envelope.result)` (V1.3.3-4, Bug A) → the model's
 *      inner payload, recovered from optional surrounding prose. Throws
 *      `JsonExtractionError` for irrecoverable shapes (translated here
 *      into `kind: 'retryable'`).
 *   4. (zod validation against the findings schema stays the consumer's job,
 *      via `safeJson(result.raw, …)`.)
 *
 * Pure — side effects (error-file persistence, the WARN line on recovery,
 * throwing) stay in `run`:
 *   - `success`  — `inner` is the model's response string, `innerJson` its
 *                  parsed form. `recoveredPreamble` carries the AH1
 *                  tri-state that drives the WARN line in `run`.
 *   - `retryable`— outer JSON, envelope shape, or inner JSON did not parse;
 *                  the reformat retry still applies.
 *   - `api-error`— well-formed envelope reporting a non-success outcome;
 *                  `run` persists a dump and throws {@link ClaudeApiError},
 *                  with no retry.
 */
function interpretEnvelope(stdout: string): EnvelopeInterpretation {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    // TR-2 (V1.9.6): stdout that is not JSON at all is left `retryable` (one
    // cheap reformat hedge), NOT `contract-mismatch`. A non-JSON body is
    // ambiguous — a transient stream hiccup, a stray banner — whereas valid
    // JSON of the WRONG SHAPE (below) is a specific, deterministic signal of
    // envelope-contract drift that a retry cannot fix.
    return { kind: 'retryable', error: `envelope is not valid JSON: ${errMsg(err)}` };
  }

  const parsed = claudeEnvelopeSchema.safeParse(outer);
  if (!parsed.success) {
    // TR-2 (V1.9.6): valid JSON, wrong envelope shape → contract drift. Distinct
    // from an inner-payload malformation (the `extractJsonValue` branch below,
    // which stays `retryable` — that IS a model error the reformat retry can
    // fix). `run` skips the retry here and throws ClaudeEnvelopeContractError.
    return {
      kind: 'contract-mismatch',
      error: `unexpected claude envelope shape: ${parsed.error.message}`,
    };
  }
  const envelope = parsed.data;

  if (envelope.is_error || envelope.subtype !== 'success') {
    return {
      kind: 'api-error',
      subtype: envelope.subtype,
      isError: envelope.is_error,
      // Normalise the (string | number | null | undefined) envelope field to the
      // `string | null` contract every consumer expects — a numeric HTTP status
      // (e.g. 400/429) becomes its decimal string ('400'/'429'), so the `=== '429'`
      // rate-limit fast-path (isRateLimitedApiError) keeps matching enveloped 429s.
      apiErrorStatus:
        envelope.api_error_status != null ? String(envelope.api_error_status) : null,
      result: envelope.result,
    };
  }

  let extracted: { json: unknown; preamble?: string; jsonText: string };
  try {
    extracted = extractJsonValue(envelope.result);
  } catch (err) {
    if (err instanceof JsonExtractionError) {
      return {
        kind: 'retryable',
        error: `envelope.result is not valid JSON: ${err.message}`,
      };
    }
    throw err;
  }
  // `inner` is the byte-fidelity JSON portion of envelope.result: the
  // whole string on the happy path, the balanced slice on recovery.
  // Downstream consumers re-parse via `safeJson(result.raw, …)`; making
  // recovery flow through `jsonText` keeps that contract unmodified
  // (see src/util/schema.ts:99, src/checks/_shared.ts:131,
  // src/generation/retry-loop.ts:335).
  const success: SuccessInterpretation = {
    kind: 'success',
    inner: extracted.jsonText,
    innerJson: extracted.json,
    ...(extracted.preamble !== undefined ? { recoveredPreamble: extracted.preamble } : {}),
    ...parseUsageExtras(outer),
  };
  return success;
}

/**
 * V1.9.4 PERF-1 — pull the additive observability extras (`usage`,
 * `total_cost_usd`, `num_turns`, `session_id`) off the already-parsed envelope
 * JSON. Best-effort: on any shape mismatch every extra is dropped (returns
 * `{}`) — capture must never perturb the success/retry decision in
 * {@link interpretEnvelope}. `total_cost_usd: null` (estimate unavailable, e.g.
 * Max) is treated as absent. Built with optional `zod`, no `as`.
 */
function parseUsageExtras(
  outer: unknown,
): Pick<SuccessInterpretation, 'usage' | 'totalCostUsd' | 'numTurns' | 'sessionId'> {
  const parsed = usageEnvelopeSchema.safeParse(outer);
  if (!parsed.success) return {};
  const d = parsed.data;
  const u = d.usage;
  const usage: ClaudeUsage | undefined =
    u !== undefined
      ? {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        }
      : undefined;
  return {
    ...(usage !== undefined ? { usage } : {}),
    ...(typeof d.total_cost_usd === 'number' ? { totalCostUsd: d.total_cost_usd } : {}),
    ...(d.num_turns !== undefined ? { numTurns: d.num_turns } : {}),
    ...(d.session_id !== undefined ? { sessionId: d.session_id } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * V1.3.3-4 (Bug A) — emit the AH1 recovery WARN line on stderr when
 * `extractJsonValue` reported a non-`undefined` preamble. Two distinct
 * shapes so a future "just emit one WARN" refactor is caught by the
 * witness in `binary-runner.test.ts`:
 *
 *   - `recoveredPreamble === ''` → trailing-prose recovery (JSON at
 *     offset 0; trailing prose was discarded).
 *   - `recoveredPreamble !== ''` → leading-prose recovery (carries the
 *     byte count and the first 50 chars of the preamble, with control
 *     characters replaced by `.` to keep the stderr stream readable).
 *
 * Unconditional — not gated on `--verbose`. Mirrors the V1.3.2-3
 * `[WARN] refinement feedback truncated …` precedent.
 */
function emitRecoveryWarn(interp: {
  readonly inner: string;
  readonly recoveredPreamble?: string;
}): void {
  const preamble = interp.recoveredPreamble;
  if (preamble === undefined) {
    return;
  }
  if (preamble === '') {
    const innerBytes = Buffer.byteLength(interp.inner, 'utf8');
    process.stderr.write(
      `[WARN] LLM emitted trailing prose after JSON body ` +
        `(extractor recovered ${innerBytes}-byte JSON; trailing text discarded).\n`,
    );
    return;
  }
  const preambleBytes = Buffer.byteLength(preamble, 'utf8');
  const head = preamble.slice(0, 50).replace(/[\x00-\x1f\x7f]/g, '.');
  process.stderr.write(
    `[WARN] LLM emitted prose preamble (${preambleBytes} chars), ` +
      `recovered inner JSON. Preamble: ${head}...\n`,
  );
}

function finalize(
  result: ExecResult,
  interp: SuccessInterpretation,
  callId: string,
): ClaudeRunResult {
  return {
    ok: result.exitCode === 0 && result.ok,
    json: interp.innerJson,
    raw: interp.inner,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    callId,
    // V1.9.4 PERF-1 — forward the additive observability extras (absent when
    // the envelope carried none; never a zero placeholder).
    ...(interp.usage !== undefined ? { usage: interp.usage } : {}),
    ...(interp.totalCostUsd !== undefined ? { totalCostUsd: interp.totalCostUsd } : {}),
    ...(interp.numTurns !== undefined ? { numTurns: interp.numTurns } : {}),
    ...(interp.sessionId !== undefined ? { sessionId: interp.sessionId } : {}),
  };
}
