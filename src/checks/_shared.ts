/**
 * Internal helpers for SPEC §2.8 check modules. Centralises:
 *   - the system prompt every check uses;
 *   - the response schemas;
 *   - the call sequence (consume budget → buildClaudeArgs → run → safeJson)
 *     so the budget/runner/zod invariants from CLAUDE.md hold uniformly;
 *   - normalisation from zod-inferred output (`line?: number | undefined`)
 *     to the project's strict `Finding` (`exactOptionalPropertyTypes` —
 *     `line?: number`).
 *
 * `_` prefix marks this as a sibling-private module; only files under
 * `src/checks/` import it.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  canCallForCategory,
  recordCallForCategory,
  recordSkippedForCategory,
} from '../budget/cap.js';
import {
  ClaudeApiError,
  ClaudeProcessKilledError,
  MalformedLlmOutputError,
  RateLimitExhaustedError,
} from '../claude/binary-runner.js';
import { RATE_LIMIT_BACKOFF_MS, withRateLimitBackoff } from '../claude/budget.js';
import { RATE_LIMIT_SIGNAL_RE } from '../claude/rate-limit-signal.js';
import { buildClaudeArgs, type ClaudeRunResult } from '../claude/runner.js';
import type { ProjectLanguage } from '../project/detect.js';
import type { CheckId, Finding } from '../types.js';
import { findingsSchema, manualFindingSchema, safeJson } from '../util/schema.js';
import type { CheckContext } from './types.js';

/**
 * V1.4-5 (AC3, AH4) — strengthened with explicit DO / rejected-shape
 * examples. The previous three-sentence concatenation was a soft
 * declarative prohibition; this version pins each rejected shape to a
 * literal example, matching V1.3.2-3's `SAP_BUNDLED_SINON_CLAUSE`
 * pattern of binding frontier models away from a class of mistake via
 * negative examples.
 *
 * Markdown fences are referred to as "(three backticks)" rather than
 * written literally because frontier models DO parse markdown in
 * prompts and would treat a fenced "DO NOT wrap in markdown fences"
 * example as a sanctioned code block boundary (AH4).
 *
 * The V1.3.3-4 `extractJsonValue` recovery is the safety net: this
 * stronger prompt should reduce `[WARN] LLM emitted prose preamble`
 * frequency but cannot eliminate it.
 */
export const SYSTEM_PROMPT = [
  'You are a static-analysis assistant for SAPUI5 (JavaScript) projects.',
  'Follow instructions exactly. Respond with a SINGLE JSON value matching the requested schema.',
  '',
  // R1.7c (AUDIT §5.7b): this system prompt fronts BOTH call classes — the
  // checks (which answer with the {"findings":[...]} envelope) and the
  // generation/refinement calls ({"newFileContent":...}) — so the
  // acceptable-shape examples show one of each. Previously only the
  // generator shape appeared, mis-steering the seven check prompts.
  'Acceptable responses (the JSON value alone, no surrounding text):',
  '  {"findings":[]}',
  '  {"newFileContent":"sap.ui.define([], function(){});"}',
  '',
  'Rejected shapes (the parser refuses these):',
  '  Prefixing with prose:    The issue: foo bar. {"newFileContent":"..."}',
  '  Wrapping in fences:      (three backticks)json {"newFileContent":"..."} (three backticks)',
  '  Trailing commentary:     {"newFileContent":"..."} // hope this helps',
  '',
  'If you have thinking you want to share, omit it. The downstream system reads only the JSON value.',
].join('\n');

/**
 * V1.9 GA1-10 — the TypeScript-framed system prompt. It differs from
 * {@link SYSTEM_PROMPT} in exactly two places: the project-language descriptor,
 * and the generator acceptable-example (an ES-module/class shape, NOT
 * `sap.ui.define([...])` AMD — the AMD form is build output; steering the model
 * to it would corrupt an ES-module `.ts` file). The findings envelope, the
 * rejected-shape examples, and the SINGLE-JSON-value framing are identical, so
 * the JSON-contract guardrails the JS prompt earns transfer unchanged.
 */
export const TS_SYSTEM_PROMPT = [
  'You are a static-analysis assistant for SAPUI5 (TypeScript) projects.',
  'Follow instructions exactly. Respond with a SINGLE JSON value matching the requested schema.',
  '',
  'Acceptable responses (the JSON value alone, no surrounding text):',
  '  {"findings":[]}',
  '  {"newFileContent":"export default class Example extends Controller {}"}',
  '',
  'Rejected shapes (the parser refuses these):',
  '  Prefixing with prose:    The issue: foo bar. {"newFileContent":"..."}',
  '  Wrapping in fences:      (three backticks)json {"newFileContent":"..."} (three backticks)',
  '  Trailing commentary:     {"newFileContent":"..."} // hope this helps',
  '',
  'The file is a TypeScript ES module (`import ... from "..."`, `export default class ... extends ...`); keep any newFileContent in that form and NEVER wrap it in `sap.ui.define([...], function () { ... })`.',
  'If you have thinking you want to share, omit it. The downstream system reads only the JSON value.',
].join('\n');

/**
 * V1.9 GA1-10 — the system prompt for a given source language. `'js'` returns
 * the byte-identical {@link SYSTEM_PROMPT}; `'ts'` returns {@link
 * TS_SYSTEM_PROMPT}. The single sanctioned selector — both the check call path
 * ({@link callLlmForFindings}) and the validate refinement path
 * (`commands/validate.ts`) route through it.
 */
export function systemPromptFor(language: ProjectLanguage): string {
  return language === 'ts' ? TS_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

/**
 * V1.9 GA1-10 — the markdown code-fence tag for a source snippet. `'ts'` →
 * ` ```typescript `, `'js'` → ` ```javascript ` (the byte-identical legacy
 * fence). Used by the source-fenced check prompt builders.
 */
export function sourceFence(language: ProjectLanguage): 'typescript' | 'javascript' {
  return language === 'ts' ? 'typescript' : 'javascript';
}

/**
 * V1.9 GA1-10 — the TS framing block spliced into a source-fenced check prompt
 * for a TypeScript project. Empty (`[]`) for `'js'`, so the JS prompt text stays
 * byte-identical. Pins the model to idiomatic TypeScript/ES-module fixes and —
 * the load-bearing instruction — forbids rewriting an ES-module file into the
 * `sap.ui.define([...])` AMD form, which would corrupt the source (diagnosis
 * §2.5). Inserted immediately before the `File:`/source block in each builder.
 */
export function tsSourceGuidance(language: ProjectLanguage): readonly string[] {
  if (language !== 'ts') return [];
  return [
    'NOTE: This is a TypeScript SAPUI5 project. The source below uses ES module',
    'syntax (`import X from "..."`) and an `export default class ... extends ...`',
    'shape — NOT the `sap.ui.define([...], function () { ... })` AMD form (that',
    'form exists only as transpiled build output). Treat exported / public CLASS',
    'members as the public surface. Any proposedFix MUST stay idiomatic',
    'TypeScript / ES-module: preserve the `import` statements and the class, keep',
    'type annotations, and NEVER rewrite the file into `sap.ui.define(...)` —',
    'doing so would corrupt the source.',
    '',
  ];
}

/**
 * V1.9.4 PERF-7 — the per-call tool grant for the read-only check paths. A
 * semantic check NEVER edits a file or runs a Bash command: it embeds the
 * source in the prompt and answers with a `{"findings":[…]}` value. So it needs
 * only the read tools, and passing this narrowed set (a strict subset of
 * `ALLOWED_TOOLS`, enforced by `buildClaudeArgs`'s §1.7 subset assertion) drops
 * the four `Bash(...)` tools and `Edit` from the cached tool-definition prefix
 * of every findings call (diagnosis PERF-7, §7-2).
 *
 * Boundary: this trim is for read-only CHECKS only. The test-AUTHORING generate
 * call (`generation/retry-loop.ts`) and the refinement-fix call
 * (`commands/validate.ts`) are deliberately NOT trimmed — they produce
 * `newFileContent` and may legitimately need the fuller grant; narrowing them is
 * a feature-removing bet that risks a higher refinement rate (net token loss).
 */
const READ_ONLY_CHECK_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob']);

const checkResponseSchema = z.object({ findings: findingsSchema });
const manualCheckResponseSchema = z.object({
  findings: z.array(manualFindingSchema),
});

export type FindingMode = 'auto-fixable-or-manual' | 'manual-only';

export interface CallLlmInput {
  readonly checkId: CheckId;
  /** Path used to attribute a malformed-output finding back to the user. */
  readonly file: string;
  readonly prompt: string;
  readonly mode: FindingMode;
  readonly ctx: CheckContext;
}

/**
 * The single sanctioned LLM call path for checks (SPEC §1.5, §2.12,
 * CLAUDE.md): consume budget, build args via `buildClaudeArgs`, invoke the
 * runner, validate with `safeJson` against the mode's schema, then
 * normalise to the project's strict `Finding` shape.
 *
 * Behaviour:
 *   - `BudgetExhaustedError` propagates (run loop catches it).
 *   - `MalformedLlmOutputError` from BinaryRunner's reformat retry — and
 *     any schema-validation failure — surfaces as a single Finding with
 *     `proposedFix: null` + explanation. The check never throws for bad
 *     LLM output (CLAUDE.md Session-7 contract).
 */
export async function callLlmForFindings(input: CallLlmInput): Promise<readonly Finding[]> {
  // V1.2-2 per-category cap. Enforced BEFORE budget.consume() so a capped
  // category does not steal a global call slot — the spared budget stays
  // available to other checks. A skipped attempt produces no finding (the
  // category's prior findings already populated `report.files`; the
  // skip-count surfaces in `report.cappedChecks`). COR-7: `capState` is now a
  // required field, so the cap is ALWAYS enforced — there is no undefined
  // branch that could silently disable it (the V1.1 starvation regression).
  if (!canCallForCategory(input.ctx.capState, input.checkId)) {
    recordSkippedForCategory(input.ctx.capState, input.checkId);
    return [];
  }

  input.ctx.budget.consume();
  // Record the consumed call up-front so a thrown rate-limit / kill from the
  // runner cannot leave the cap unincremented — the call slot was spent
  // regardless of whether the LLM produced parseable output.
  recordCallForCategory(input.ctx.capState, input.checkId);

  const args = buildClaudeArgs({
    prompt: input.prompt,
    // V1.9 GA1-10 — TS projects get the TypeScript-framed system prompt; JS is
    // byte-identical (default `'js'`).
    systemPrompt: systemPromptFor(input.ctx.projectLanguage ?? 'js'),
    cwd: input.ctx.projectRoot,
    // V1.9.4 PERF-7 — a read-only check needs only the read tools; narrow the
    // §1.7 grant to trim the cached tool-definition prefix.
    tools: READ_ONLY_CHECK_TOOLS,
    // V1.9.4 PERF-17 — forward the user-selected model when set; unset keeps the
    // args byte-identical to today.
    ...(input.ctx.model !== undefined ? { model: input.ctx.model } : {}),
    ...(input.ctx.signal !== undefined ? { signal: input.ctx.signal } : {}),
  });

  let result: ClaudeRunResult;
  try {
    result = await withRateLimitBackoff(() => input.ctx.runner.run(args), {
      isRateLimited: isRateLimitedResult,
      // D1 (V1.5): a 429 arrives as a THROWN ClaudeApiError, not a returned
      // result — retry it on the same SPEC §2.12 schedule instead of letting
      // it skip backoff and become a per-finding api-error.
      isRateLimitedError: isRateLimitedApiError,
      throwOnExhaustion: (r) =>
        new RateLimitExhaustedError(
          r.callId,
          RATE_LIMIT_BACKOFF_MS.length + 1,
          describeRateLimitedResult(r),
        ),
      throwOnExhaustionError: rateLimitExhaustedFromError,
    });
  } catch (err) {
    // V1.2-3: rate-limit-exhaustion is a run-terminating signal, not a
    // per-finding failure — never convert it to a Finding. Caught BEFORE
    // ClaudeApiError so the more-specific class wins the arm; the validate
    // orchestrator catches it at the runCheckLoop / applyAndVerifyFix
    // boundaries to finalise the report with `{ kind: 'rate-limited' }`.
    if (err instanceof RateLimitExhaustedError) {
      throw err;
    }
    if (err instanceof MalformedLlmOutputError) {
      return [malformedFinding(input.checkId, input.file, err.message)];
    }
    if (err instanceof ClaudeProcessKilledError) {
      return [await processKilledFinding(input.checkId, input.file, input.ctx, err)];
    }
    if (err instanceof ClaudeApiError) {
      return [apiErrorFinding(input.checkId, input.file, err)];
    }
    throw err;
  }

  const schema =
    input.mode === 'manual-only' ? manualCheckResponseSchema : checkResponseSchema;
  const parsed = safeJson(result.raw, schema);
  if (!parsed.ok) {
    return [malformedFinding(input.checkId, input.file, parsed.error)];
  }
  return parsed.data.findings.map((f) => normalizeFinding(f, input.file));
}

/**
 * V1.9.4 PERF-2/8 — the batched sibling of {@link callLlmForFindings}. ONE LLM
 * call covers SEVERAL checks over a single file (the 3 controller checks, or the
 * 2 view checks), so the per-call overhead AND the embedded source are paid once
 * instead of per-check (3N→N controllers, 2M→M views). The response is parsed by
 * the SAME {@link checkResponseSchema} (`{"findings":[…]}`) and normalised by the
 * SAME {@link normalizeFinding} (the `file` pin is unchanged) — checks emit
 * findings only, so the verify-then-accept flow downstream is byte-for-byte the
 * per-check path. `mode` is implicit: the batch always uses the
 * auto-fixable-OR-manual schema because it mixes auto-fixable checks (no-direct-dom
 * / no-sync-odata / missing-i18n / globals-in-views) with the manual-only
 * missing-test-coverage; the prompt instructs the latter to return
 * `proposedFix: null`, and `findingsSchema` constrains every `checkId` to the
 * known union (mis-attribution is bounded to valid ids — diagnosis §4 approach f).
 *
 * Cap accounting — the load-bearing partial-cap rule: the batch fires IFF EVERY
 * included `checkId` is under its per-category cap. On a fire it consumes ONE
 * global budget call and records ONE call per included `checkId`. If ANY included
 * `checkId` is capped, the WHOLE batch is skipped — one skip recorded per included
 * `checkId`, no budget consumed, no LLM call — so a capped category is never
 * over-called. This reproduces the per-check `cappedChecks` accounting exactly:
 * each category still books one call (or one skip) per file.
 *
 * On a transport failure the batch surfaces ONE finding PER included `checkId`
 * (mirroring the per-check path, where each check that ran would have produced its
 * own error finding for the file). {@link RateLimitExhaustedError} propagates
 * (run-terminating); {@link BudgetExhaustedError} propagates from
 * `budget.consume()`.
 */
export async function callLlmForFindingsBatch(input: {
  readonly checkIds: readonly CheckId[];
  readonly file: string;
  readonly prompt: string;
  readonly ctx: CheckContext;
  /**
   * V1.9.8 — the detection cache key (computed next to prompt assembly in
   * `batch.ts`). Present iff the run carries `ctx.detectionCache`; both must
   * be set for the cache to participate.
   */
  readonly cacheKey?: string;
}): Promise<readonly Finding[]> {
  // V1.9.8 — cross-run detection cache. The lookup is SYNCHRONOUS (the store
  // was pre-loaded at run start) and sits ABOVE the cap prelude: a HIT is not
  // a call — it consumes no budget and no cap increment, so it is served even
  // when the category is capped (it costs nothing). It also short-circuits
  // above `ctx.runner.run(...)`, so `AuditingRunner` never writes a
  // prompt/response transcript for a call that never happened.
  const cache = input.ctx.detectionCache;
  if (cache !== undefined && input.cacheKey !== undefined) {
    const served = cache.get(input.cacheKey, input.file);
    if (served !== undefined) return served;
  }

  // Partial-cap rule: fire only when EVERY included category is under its cap.
  if (!input.checkIds.every((id) => canCallForCategory(input.ctx.capState, id))) {
    for (const id of input.checkIds) recordSkippedForCategory(input.ctx.capState, id);
    return [];
  }

  input.ctx.budget.consume();
  // Record one consumed call per included category up-front (mirrors
  // callLlmForFindings) so a thrown rate-limit / kill from the runner cannot
  // leave any covered category's cap unincremented.
  for (const id of input.checkIds) recordCallForCategory(input.ctx.capState, id);

  const args = buildClaudeArgs({
    prompt: input.prompt,
    systemPrompt: systemPromptFor(input.ctx.projectLanguage ?? 'js'),
    cwd: input.ctx.projectRoot,
    // V1.9.4 PERF-7 — the batch is still a read-only findings call; same trim.
    tools: READ_ONLY_CHECK_TOOLS,
    ...(input.ctx.model !== undefined ? { model: input.ctx.model } : {}),
    ...(input.ctx.signal !== undefined ? { signal: input.ctx.signal } : {}),
  });

  let result: ClaudeRunResult;
  try {
    result = await withRateLimitBackoff(() => input.ctx.runner.run(args), {
      isRateLimited: isRateLimitedResult,
      isRateLimitedError: isRateLimitedApiError,
      throwOnExhaustion: (r) =>
        new RateLimitExhaustedError(
          r.callId,
          RATE_LIMIT_BACKOFF_MS.length + 1,
          describeRateLimitedResult(r),
        ),
      throwOnExhaustionError: rateLimitExhaustedFromError,
      // THR-2/THR-4 (V1.9.7): in a concurrent validate run, share the backoff
      // window so a 429 in ANY batch worker drains new dispatch pool-wide (the
      // claim-loop gate in runCheckBatches). Absent on the sequential path
      // (K=1 / undefined signal) → byte-identical to before.
      ...(input.ctx.rateLimitSignal !== undefined
        ? { signal: input.ctx.rateLimitSignal }
        : {}),
    });
  } catch (err) {
    if (err instanceof RateLimitExhaustedError) throw err;
    if (err instanceof MalformedLlmOutputError) {
      return input.checkIds.map((id) => malformedFinding(id, input.file, err.message));
    }
    if (err instanceof ClaudeProcessKilledError) {
      return Promise.all(
        input.checkIds.map((id) => processKilledFinding(id, input.file, input.ctx, err)),
      );
    }
    if (err instanceof ClaudeApiError) {
      return input.checkIds.map((id) => apiErrorFinding(id, input.file, err));
    }
    throw err;
  }

  const parsed = safeJson(result.raw, checkResponseSchema);
  if (!parsed.ok) {
    return input.checkIds.map((id) => malformedFinding(id, input.file, parsed.error));
  }
  const findings = parsed.data.findings.map((f) => normalizeFinding(f, input.file));
  // V1.9.8 — only a successfully parsed batch result is cached. Error findings
  // (malformed / api-error / process-killed above) are transport failures, not
  // detection results — caching one would freeze an outage into the store.
  if (cache !== undefined && input.cacheKey !== undefined) {
    cache.put(input.cacheKey, findings);
  }
  return findings;
}

type LlmFinding = z.infer<typeof findingsSchema>[number];

/**
 * R1.1 (AUDIT §5.2): `file` is pinned to the scanned target, never taken
 * from the LLM. Every check sends exactly one file per call (single-file
 * contract), so any other value is illegitimate — and raw project source is
 * embedded in prompts, so an injected comment could otherwise redirect a
 * `newFileContent` rewrite to an arbitrary existing file.
 */
function normalizeFinding(f: LlmFinding, scannedFile: string): Finding {
  const lineExtra = f.line !== undefined ? { line: f.line } : {};
  if (f.proposedFix === null) {
    return {
      checkId: f.checkId,
      file: scannedFile,
      message: f.message,
      source: 'check',
      proposedFix: null,
      explanation: f.explanation,
      ...lineExtra,
    };
  }
  return {
    checkId: f.checkId,
    file: scannedFile,
    message: f.message,
    source: 'check',
    proposedFix: f.proposedFix,
    ...lineExtra,
  };
}

/**
 * The canonical rate-limit signal is shared by the result classifier
 * ({@link isRateLimitedResult}), the thrown-error classifier
 * ({@link isRateLimitedApiError}), and — since V1.9.3 (D2) — the transport
 * boundary in `claude/binary-runner.ts`, so all three look for the same surface.
 * It lives in the leaf module `claude/rate-limit-signal.ts` to avoid the
 * `binary-runner → _shared → binary-runner` cycle (this file imports the error
 * classes from `binary-runner`); imported here for the classifiers below and
 * re-exported for back-compat.
 */
export { RATE_LIMIT_SIGNAL_RE };

/**
 * Heuristic SPEC §2.12 rate-limit classifier for a returned result. A passing
 * result is never rate-limited — guards against false positives that would
 * waste budget.
 */
export function isRateLimitedResult(result: ClaudeRunResult): boolean {
  if (result.ok) return false;
  return RATE_LIMIT_SIGNAL_RE.test(`${result.stderr}\n${result.raw}`);
}

/**
 * V1.5 (D1) — classify a THROWN runner error as rate-limit-shaped. The real
 * `claude -p` CLI returns a 429 as an `is_error` envelope that `BinaryRunner`
 * surfaces as a thrown {@link ClaudeApiError}; this lets `withRateLimitBackoff`
 * retry it on the SPEC §2.12 schedule instead of bypassing backoff entirely.
 * Deliberately narrow: only a rate-limit / quota signal matches, so an auth or
 * `error_max_turns` `ClaudeApiError` still propagates immediately (retrying it
 * is futile).
 */
export function isRateLimitedApiError(err: unknown): boolean {
  if (!(err instanceof ClaudeApiError)) return false;
  if (err.apiErrorStatus === '429') return true;
  return RATE_LIMIT_SIGNAL_RE.test(`${err.subtype}\n${err.result}`);
}

/**
 * V1.5 (D1) — build the terminal {@link RateLimitExhaustedError} for the
 * thrown-error backoff path (`withRateLimitBackoff`'s `throwOnExhaustionError`),
 * mirroring {@link describeRateLimitedResult}'s detail preference.
 */
export function rateLimitExhaustedFromError(err: unknown): RateLimitExhaustedError {
  if (err instanceof ClaudeApiError) {
    const detail = err.result.trim().length > 0 ? err.result.slice(0, 500) : err.message;
    return new RateLimitExhaustedError(err.callId, RATE_LIMIT_BACKOFF_MS.length + 1, detail);
  }
  return new RateLimitExhaustedError('unknown', RATE_LIMIT_BACKOFF_MS.length + 1, String(err));
}

/**
 * V1.2-3: build the `lastAttemptDetail` string carried on a
 * {@link RateLimitExhaustedError}. Prefers stderr (the canonical rate-limit
 * channel from the `claude` CLI), falls back to a truncated `raw` payload,
 * and finally to the exit code so the audit log / human message always has
 * something concrete to surface even when both streams are empty.
 */
export function describeRateLimitedResult(result: ClaudeRunResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr.slice(0, 500);
  const raw = result.raw.trim();
  if (raw.length > 0) return `raw output: ${raw.slice(0, 500)}`;
  return `exitCode ${result.exitCode}`;
}

function malformedFinding(checkId: CheckId, file: string, errorMessage: string): Finding {
  return {
    checkId,
    file,
    message: `LLM returned malformed output for ${checkId}; finding could not be produced.`,
    source: 'check',
    proposedFix: null,
    explanation: errorMessage,
  };
}

/**
 * Surface a {@link ClaudeApiError} — a well-formed `claude` envelope reporting
 * a non-success outcome (auth failure, rate limit, `error_max_turns`, …) — as
 * a finding under the original `checkId`. Distinct from {@link malformedFinding}:
 * the envelope parsed fine; the API call inside the CLI failed. The explanation
 * carries the envelope's own diagnostic so it never reads as the Bug 3
 * "Schema validation failed" symptom.
 */
function apiErrorFinding(checkId: CheckId, file: string, err: ClaudeApiError): Finding {
  return {
    checkId,
    file,
    message: `Claude API error during ${checkId}; finding could not be produced.`,
    source: 'check',
    proposedFix: null,
    explanation:
      `The claude CLI returned an error envelope (subtype "${err.subtype}"` +
      (err.apiErrorStatus !== null ? `, api_error_status "${err.apiErrorStatus}"` : '') +
      `) instead of a model response, so the ${checkId} check could not run ` +
      `against this file. Error detail: ${err.result}`,
  };
}

/**
 * Surface a killed `claude` subprocess as a finding under the original
 * `checkId` — distinct from {@link malformedFinding}. `process-killed` is a
 * finding outcome, not a check identifier, so it never enters the `CheckId`
 * union. The explanation records the file size and observed exit code, and
 * points at scope exclusion (V1.1-DIAGNOSIS.md §"Bug 4") since oversized
 * vendor/minified files are the usual trigger.
 */
async function processKilledFinding(
  checkId: CheckId,
  file: string,
  ctx: CheckContext,
  err: ClaudeProcessKilledError,
): Promise<Finding> {
  let sizeNote = 'file size unavailable';
  try {
    const stats = await stat(resolve(ctx.projectRoot, file));
    sizeNote = `${stats.size} bytes`;
  } catch {
    // Best-effort: keep the default note if the file can't be stat'd.
  }
  return {
    checkId,
    file,
    message:
      'Claude produced no output for this file; it may be too large to send in ' +
      'a single prompt, or the process was killed by the system.',
    source: 'check',
    proposedFix: null,
    explanation:
      `The claude subprocess produced no output (exit code ${err.exitCode}), so ` +
      `the ${checkId} check could not run against this file. Input file size: ` +
      `${sizeNote}. The most common cause is a file too large to embed in one ` +
      `prompt — the assembled command line then exceeds the OS process-argument ` +
      `limit (B1). If this is a legitimate large file, exclude it from this run ` +
      `or split it into smaller modules; if it is vendor or minified content, ` +
      `exclude it from scope (V1.1 Bug 4). The reformat retry was skipped ` +
      `because an empty-output kill cannot be recovered by re-prompting.`,
  };
}
