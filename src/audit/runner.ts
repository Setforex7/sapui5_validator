/**
 * Audit decorators wiring `AuditLog` into the two call sites that produce
 * auditable events:
 *
 *   - `AuditingRunner` wraps a `ClaudeRunner` and persists prompt + response
 *     pairs keyed by the runner's `callId`. The success path and all three
 *     typed runner failures (`MalformedLlmOutputError`,
 *     `ClaudeProcessKilledError`, `ClaudeApiError`) write a response, so every
 *     prompt has a sibling response on disk (required by the audit-log routing
 *     contract — see `test/e2e-real/audit-log-routing.e2e.test.ts`).
 *
 *   - `wrapVerifyFnWithAudit` decorates the orchestrator's verify function so
 *     each non-skipped pipeline step lands a `<callId>-<step>.txt` dump. The
 *     callId here is synthesized per call (the verify pipeline has no LLM
 *     correlation handle in V1; see V1.1-DIAGNOSIS.md §"Bug 5 → writeVerify
 *     correlation").
 *
 * Keeping these as decorators preserves the SPEC §1.5 `ClaudeRunner` seam:
 * production wraps with audit; the in-memory `FakeClaudeRunner` used by unit
 * tests stays untouched.
 */

import { randomUUID } from 'node:crypto';
import {
  ClaudeApiError,
  ClaudeEnvelopeContractError,
  ClaudeProcessKilledError,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
} from '../claude/binary-runner.js';
import type { ClaudeRunArgs, ClaudeRunResult, ClaudeRunner } from '../claude/runner.js';
import type {
  VerifyPipelineInput,
  VerifyResult,
  VerifyStepResult,
} from '../verify/pipeline.js';
import type { AuditLog } from './log.js';

export class AuditingRunner implements ClaudeRunner {
  /**
   * @param onResult V1.9.4 PERF-1 — optional per-call sink for the run's
   *   single usage accumulator. AuditingRunner is the one decorator every
   *   production call already flows through, so it is the natural choke point to
   *   forward each successful result's `usage`/`totalCostUsd` (the error paths
   *   below carry no usage). Pure accumulation — it must not throw; omitted in
   *   the unit fakes that don't measure spend.
   */
  constructor(
    private readonly inner: ClaudeRunner,
    private readonly audit: AuditLog,
    private readonly onResult?: (result: ClaudeRunResult) => void,
  ) {}

  async run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    try {
      const result = await this.inner.run(args);
      this.onResult?.(result);
      // COR-2 (§2.2): the audit transcript is best-effort. A disk-full /
      // locked-dir write failure must not crash a call whose paid-for LLM
      // result already succeeded — warn so the missing transcript is explained
      // and still return the result. Mirrors the verify-audit path below and
      // the baseline-karma probe site in generate.ts (both already hardened).
      try {
        await Promise.all([
          this.audit.writePrompt(result.callId, args.prompt),
          this.audit.writeResponse(result.callId, result.raw),
        ]);
      } catch (writeErr) {
        process.stderr.write(
          `[WARN] failed to write audit transcript for call ${result.callId}: ` +
            `${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`,
        );
      }
      return result;
    } catch (err) {
      if (err instanceof MalformedLlmOutputError) {
        // Still record both sides of the call so the routing invariant
        // (every response has a sibling prompt) holds even on the failure
        // path. The response body captures what the runner could observe
        // about the failure — the raw error file on disk is the
        // authoritative dump.
        const responsePayload = JSON.stringify(
          {
            error: 'MalformedLlmOutputError',
            message: err.message,
            errorFilePath: err.errorFilePath,
          },
          null,
          2,
        );
        await Promise.all([
          this.audit.writePrompt(err.callId, args.prompt),
          this.audit.writeResponse(err.callId, responsePayload),
        ]);
      } else if (err instanceof ClaudeEnvelopeContractError) {
        // TR-2 (V1.9.6): an envelope-contract mismatch (CLI drift) still records
        // both sides so the routing invariant holds. The response captures the
        // contract detail; the raw envelope dump on disk is authoritative.
        const responsePayload = JSON.stringify(
          {
            error: 'ClaudeEnvelopeContractError',
            message: err.message,
            detail: err.detail,
            errorFilePath: err.errorFilePath,
          },
          null,
          2,
        );
        await Promise.all([
          this.audit.writePrompt(err.callId, args.prompt),
          this.audit.writeResponse(err.callId, responsePayload),
        ]);
      } else if (err instanceof ClaudeProcessKilledError) {
        // A killed subprocess still gets both sides recorded so the routing
        // invariant holds. The response captures the (empty) raw output and
        // the exitCode metadata; the raw error file on disk is authoritative.
        const responsePayload = JSON.stringify(
          {
            error: 'ClaudeProcessKilledError',
            message: err.message,
            exitCode: err.exitCode,
            stderr: err.stderr,
            raw: '',
            errorFilePath: err.errorFilePath,
          },
          null,
          2,
        );
        await Promise.all([
          this.audit.writePrompt(err.callId, args.prompt),
          this.audit.writeResponse(err.callId, responsePayload),
        ]);
      } else if (err instanceof ClaudeApiError) {
        // A well-formed envelope reporting a non-success API outcome still
        // gets both sides recorded so the routing invariant holds. The
        // response captures the envelope's own diagnostic; the raw error file
        // on disk is authoritative.
        const responsePayload = JSON.stringify(
          {
            error: 'ClaudeApiError',
            message: err.message,
            subtype: err.subtype,
            isError: err.isError,
            apiErrorStatus: err.apiErrorStatus,
            result: err.result,
            errorFilePath: err.errorFilePath,
          },
          null,
          2,
        );
        await Promise.all([
          this.audit.writePrompt(err.callId, args.prompt),
          this.audit.writeResponse(err.callId, responsePayload),
        ]);
      } else if (err instanceof RateLimitExhaustedError) {
        // COR-3 (§2.2): defense-in-depth completing the error-taxonomy coverage
        // of this catch. In the CURRENT architecture `withRateLimitBackoff`
        // synthesizes `RateLimitExhaustedError` ONE LAYER ABOVE this runner, so
        // it is never thrown by `this.inner.run()` in production — but if a
        // future composition ever surfaces it into this layer, recording both
        // sides keeps the routing invariant ("every prompt has a sibling
        // response") intact rather than orphaning the prompt, exactly as the
        // three reachable arms above do for their error types.
        const responsePayload = JSON.stringify(
          {
            error: 'RateLimitExhaustedError',
            message: err.message,
            attemptsBeforeFailure: err.attemptsBeforeFailure,
            lastAttemptDetail: err.lastAttemptDetail,
          },
          null,
          2,
        );
        await Promise.all([
          this.audit.writePrompt(err.callId, args.prompt),
          this.audit.writeResponse(err.callId, responsePayload),
        ]);
      }
      throw err;
    }
  }
}

/**
 * Decorate a verify function so every non-skipped step dumps its stdout +
 * stderr to `verify/<callId>-<step>.txt`. The verify pipeline has no LLM
 * correlation in V1, so each invocation gets a freshly synthesized callId.
 */
export function wrapVerifyFnWithAudit(
  inner: (input: VerifyPipelineInput) => Promise<VerifyResult>,
  audit: AuditLog,
): (input: VerifyPipelineInput) => Promise<VerifyResult> {
  return async (input) => {
    const result = await inner(input);
    const callId = randomUUID();
    // R2.3(iii) (AUDIT §5.4): the audit transcript is best-effort — a failed
    // write (full disk, locked last-run/ dir) must not crash the verify path.
    // Pre-R2.3 this throw escaped through the production verifyFn into the
    // retry-loop lane / validate fix loop, which is exactly the throw class
    // R2.3(i)/(ii) guard against. Warn so the missing transcript is explained;
    // mirrors the baseline-karma probe site in generate.ts.
    try {
      await Promise.all(
        result.steps
          .filter((s) => s.status !== 'skipped')
          .map((s) =>
            audit.writeVerify(callId, s.step, formatVerifyStep(input.file, s)),
          ),
      );
    } catch (err) {
      process.stderr.write(
        `[WARN] failed to write verify audit transcript (${callId}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return result;
  };
}

function formatVerifyStep(file: string, step: VerifyStepResult): string {
  return [
    `file: ${file}`,
    `step: ${step.step}`,
    `status: ${step.status}`,
    `exitCode: ${step.exitCode}`,
    `durationMs: ${step.durationMs}`,
    '',
    '--- stdout ---',
    step.stdout,
    '',
    '--- stderr ---',
    step.stderr,
    '',
  ].join('\n');
}
