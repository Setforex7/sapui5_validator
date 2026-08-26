/**
 * V1.3.3-4 — prose-preamble JSON extractor for the `claude` envelope's
 * inner `result` payload (Bug A; cap_try Shop shape).
 *
 * The `claude -p --output-format json` envelope's `result` field is a
 * string carrying the model's response. The model occasionally wraps a
 * valid JSON object/array in prose preamble ("The issue: …\n\n{...}"),
 * which crashes the naive `JSON.parse` and used to bubble out as a
 * `MalformedLlmOutputError` after the one-shot reformat retry. This
 * extractor recovers a single balanced JSON value surrounded by
 * non-JSON text, leaving the reformat-retry path intact for the cases
 * that genuinely cannot be recovered.
 *
 * @remarks
 *
 * Five behaviour-boundary notes pin the design (also reproduced
 * verbatim in the V1.3.3-4 commit body):
 *
 * - **(AC1) Conservative by design.** One balanced JSON object/array
 *   surrounded by non-JSON text. No markdown fences (rejected at
 *   step 0 with the load-bearing message
 *   `fenced code block; refusing to strip fences`), no JSON5
 *   permissiveness, no multi-block recovery. Liberalising requires a
 *   second real-project data point and an explicit V1.4+ decision.
 * - **Balanced-block string-literal awareness.** The scanner tracks
 *   string-literal state via the count-preceding-backslashes rule:
 *   an odd number of `\` before a `"` means the quote is escaped, an
 *   even number means it terminates the string. So `{"k":"a }{ b"}`
 *   parses as one object, not as two adjacent blocks.
 * - **(AH1) Preamble tri-state.** `preamble === undefined` is the
 *   happy path (step 1 `JSON.parse` succeeded — no recovery ran).
 *   `preamble === ''` means recovery ran, the JSON was at offset 0,
 *   and trailing prose was discarded. `preamble !== ''` means real
 *   leading prose was stripped. The WARN line in `BinaryRunner.run`
 *   fires in BOTH the `''` and non-empty cases (distinct wording per
 *   AH1); absence of WARN on the happy path is pinned by an explicit
 *   negative witness (AM4).
 * - **Audit asymmetry.** The audit dump at
 *   `last-run/llm-error-<callId>.txt` is written only when both
 *   attempts fail (byte-for-byte raw stdout). Successful recovery
 *   leaves no audit artefact; the WARN line on stderr is the only
 *   observability for recovery events. The `persistError` write path
 *   is untouched.
 * - **Retry policy unchanged.** When `extractJsonValue` throws
 *   `JsonExtractionError`, the call goes through the same one-shot
 *   reformat retry as before. Recovery is a strict superset of the
 *   prior success cases AND a strict subset of the prior
 *   recoverable-via-retry cases — irrecoverable shapes still flow to
 *   the existing retry + `MalformedLlmOutputError` arm.
 *
 * The function is pure: no I/O, no logging, no globals. The caller
 * (`BinaryRunner.run` via `interpretEnvelope`) is responsible for
 * emitting the WARN line based on the returned tri-state.
 *
 * @see {@link extractJsonValue}
 * @see {@link JsonExtractionError}
 */

/**
 * Thrown by {@link extractJsonValue} when the input cannot be reduced
 * to a single balanced JSON value. The two load-bearing messages are
 * pinned by witnesses and MUST NOT change without intent:
 *
 * - `fenced code block; refusing to strip fences` — step 0 (AC1).
 * - `multiple JSON blocks; refusing to guess` — step 4 (AH2).
 *
 * Other failure modes (no JSON value at all, malformed inner JSON,
 * scanner ran off the end) use descriptive but unpinned messages —
 * the witnesses pin the throw + the class, not the wording.
 *
 * @see file-level JSDoc for behaviour boundaries.
 */
export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonExtractionError';
    Object.setPrototypeOf(this, JsonExtractionError.prototype);
  }
}

/**
 * Recover a single balanced JSON value from `text`, optionally
 * surrounded by non-JSON prose.
 *
 * Algorithm (executed in this order; see file-level JSDoc for
 * boundary rationale):
 *   0. **Fence-marker rejection (AC1).** A run of three consecutive
 *      backticks outside a string literal aborts immediately.
 *   1. **Happy-path passthrough.** `JSON.parse(text)` — if it
 *      succeeds, return `{ json, preamble: undefined, jsonText: text }`.
 *   2. **Locate candidate start.** First `{` or `[` not inside a
 *      string literal.
 *   3. **Balanced-block scan.** Walk to the matching closing
 *      brace/bracket, tracking string-literal state.
 *   4. **Multi-block refusal (AH2).** A second `{` or `[` outside a
 *      string in the trailing slice aborts.
 *   5. **Parse the slice.** `JSON.parse(text.slice(start, end + 1))`.
 *   6. **Return** with `preamble = text.slice(0, start)` (the empty
 *      string when `start === 0`) and `jsonText` equal to the parsed
 *      slice, so downstream consumers that re-parse the raw text
 *      (e.g. `safeJson(result.raw, …)`) see clean JSON.
 *
 * @returns `{ json, preamble, jsonText }` — `preamble` is `undefined`
 *   on the happy path, `''` when the JSON was at offset 0 (trailing
 *   prose discarded), or a non-empty string when leading prose was
 *   stripped. `jsonText` is the byte-fidelity JSON portion of the
 *   input (the whole input on the happy path; the balanced slice on
 *   recovery), suitable as the canonical `raw` for downstream
 *   consumers.
 *
 * @throws {@link JsonExtractionError} for irrecoverable shapes —
 *   fenced blocks, missing/unbalanced JSON, or multiple blocks.
 *
 * @see file-level JSDoc for the five behaviour boundaries.
 */
export function extractJsonValue(
  text: string,
): { json: unknown; preamble?: string; jsonText: string } {
  // Step 0 — fence-marker rejection (AC1). Walk once, tracking
  // string-literal state, and abort on three consecutive backticks
  // found outside a string. Fenced output is V1.4+ scope.
  rejectFences(text);

  // Step 1 — happy-path passthrough. The ONLY path that yields
  // `preamble: undefined` (per the AH1 tri-state).
  try {
    return { json: JSON.parse(text), jsonText: text };
  } catch {
    // fall through to recovery
  }

  // Step 2 — locate candidate start: first `{` or `[` outside a
  // string literal. If none, the input has no JSON value at all.
  const start = findCandidateStart(text);
  if (start === -1) {
    throw new JsonExtractionError('no JSON value found in text');
  }

  // Step 3 — balanced-block scan.
  const end = findMatchingClose(text, start);
  if (end === -1) {
    throw new JsonExtractionError('unbalanced JSON value: scanner ran off end of input');
  }

  // Step 4 — multi-block refusal (AH2). Trailing whitespace and
  // trailing prose without `{`/`[` characters are allowed.
  const trailingHasBlock = hasJsonStart(text, end + 1);
  if (trailingHasBlock) {
    throw new JsonExtractionError('multiple JSON blocks; refusing to guess');
  }

  // Step 5 — parse the slice.
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JsonExtractionError(`recovered JSON slice did not parse: ${msg}`);
  }

  // Step 6 — return with preamble tri-state. `start === 0` ⇒ `''`
  // (trailing prose discarded; the AH1 case). `start > 0` ⇒ the
  // leading prose verbatim. `jsonText` is the parsed slice so the
  // downstream `safeJson(result.raw, …)` re-parse sees clean JSON.
  return { json, preamble: text.slice(0, start), jsonText: slice };
}

/**
 * Step 0: scan `text` once for three consecutive backticks that are
 * NOT inside a JSON string literal, and throw `JsonExtractionError`
 * with the pinned message if any are found. Markdown fence blocks
 * are explicitly out of scope (AC1) — recovery would have to know
 * how to identify and strip both the opening and closing fence, and
 * a future maintainer should make that an intentional V1.4+ edit
 * rather than an algorithmic accident.
 */
function rejectFences(text: string): void {
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) {
        i += 2;
        continue;
      }
      if (c === 0x22 /* " */) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === 0x22 /* " */) {
      inString = true;
      i += 1;
      continue;
    }
    if (
      c === 0x60 /* ` */ &&
      text.charCodeAt(i + 1) === 0x60 &&
      text.charCodeAt(i + 2) === 0x60
    ) {
      throw new JsonExtractionError('fenced code block; refusing to strip fences');
    }
    i += 1;
  }
}

/**
 * Step 2 / Step 4 helper: the offset of the first `{` or `[` at or
 * after `from`, ignoring characters inside a JSON string literal.
 * Returns `-1` if no candidate exists.
 */
function findCandidateStart(text: string, from = 0): number {
  let inString = false;
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) {
        i += 2;
        continue;
      }
      if (c === 0x22 /* " */) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === 0x22 /* " */) {
      inString = true;
      i += 1;
      continue;
    }
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Step 4 helper: does the slice from `from` onwards contain another `{` or `[` outside a string? */
function hasJsonStart(text: string, from: number): boolean {
  return findCandidateStart(text, from) !== -1;
}

/**
 * Step 3: from `start` (which must be `{` or `[`), find the offset
 * of the matching closing brace/bracket. Tracks depth and
 * string-literal state. Returns `-1` if the scanner runs off the end
 * without closing.
 */
function findMatchingClose(text: string, start: number): number {
  const opener = text.charCodeAt(start);
  const closer = opener === 0x7b /* { */ ? 0x7d /* } */ : 0x5d /* ] */;
  let depth = 0;
  let inString = false;
  let i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) {
        i += 2;
        continue;
      }
      if (c === 0x22 /* " */) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === 0x22 /* " */) {
      inString = true;
      i += 1;
      continue;
    }
    if (c === opener) {
      depth += 1;
    } else if (c === closer) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}
