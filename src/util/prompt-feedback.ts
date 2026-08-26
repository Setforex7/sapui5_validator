/**
 * Bounded refinement-prompt feedback sanitiser (V1.3.2-3, Bug A fix;
 * rationale re-derived V1.9.6-3 for the stdin transport).
 *
 * The refinement-prompt construction in
 * [src/generation/retry-loop.ts:226](../generation/retry-loop.ts) embeds
 * verify output (karma stdout, lint errors) verbatim into the LLM prompt.
 * This function caps that LLM-facing feedback to a fixed byte budget.
 *
 * **Why the cap exists (historical → current).** It was born (V1.3.2-3) as an
 * argv-overflow fix: pre-V1.9.6 the prompt travelled on the child's argv, so a
 * 78 KB karma failure pushed the assembled `claude -p` argv past Windows
 * `CreateProcess`'s 32_767-char ceiling — the subprocess was killed and the
 * `ClaudeProcessKilledError` arm absorbed it silently (`cap_try` saw three
 * quarantines with no warning). **Since V1.9.6 (TR-1) the prompt travels on
 * the child's stdin, so the OS argv ceiling no longer bounds it** — that
 * historical rationale is spent. The cap now stands on a *token-economic*
 * footing: the feedback is the volatile part of a refinement prompt (it
 * changes on every attempt), so — unlike the cacheable system-prompt + tool
 * list prefix — it is re-sent as uncacheable input on each of up to 3 retry
 * attempts (the refine/fix cap). Bounding it bounds the per-attempt
 * uncacheable input-token cost.
 *
 * Five behaviour boundaries pin the design (also recorded in the
 * V1.3.2-3 commit body; boundary 1's *rationale* re-derived in V1.9.6-3):
 *
 * 1. **16 KiB rationale (token cost, not argv).** At ~1 token per ~3.5-4
 *    UTF-8 bytes, 16 KiB of feedback is ~4k uncacheable input tokens per
 *    attempt (~12k across a full 3-attempt refinement). The V1.9.5 baseline
 *    ([docs/runs/v1.2.0-baseline/README.md](../../docs/runs/v1.2.0-baseline/README.md))
 *    measured **0 truncations** across all 7 real runs — every real SAPUI5
 *    karma/lint dump already fit whole under 16 KiB, so the cap does not
 *    degrade fix quality; its job is to bound the *tail* (a runaway karma
 *    dump) so its uncacheable tokens cannot multiply across retries on that
 *    baseline's input-dominated cost profile (input tokens JS 109k / TS 147k).
 *    Value kept at 16 KiB: 0 truncations proves it never constrained real
 *    work, so neither raising it (a wider pathological tail, no benefit) nor
 *    lowering it (would start truncating real dumps) is justified by the data.
 *    Pinned by
 *    [test/unit/prompt-feedback.test.ts](../../test/unit/prompt-feedback.test.ts).
 * 2. **40/60 head/tail split.** karma's failure block (`FAILED`,
 *    `AssertionError`, stack frames) sits in the tail half of the
 *    output, after the bootstrap + per-test progress lines. Biasing
 *    the surviving window toward the tail keeps the load-bearing
 *    failure signal in front of the LLM.
 * 3. **Bytes-not-chars.** `Buffer.byteLength(s, 'utf8')` and
 *    `Buffer.from(s, 'utf8')` are used throughout — never `s.length`.
 *    The cap is a UTF-8 *byte* budget (bytes track token cost more
 *    faithfully than UTF-16 chars); a 4-byte emoji costs 1 char but 4
 *    budget bytes, so counting in chars would under-count and blow the
 *    budget. Slices round-trip through UTF-8 to guarantee no replacement
 *    char is introduced at the cut.
 * 4. **Per-line classification (AH2).** Stack frames are matched with
 *    anchored `/^\s*at /`, not substring `at ` (which would
 *    incidentally fire on prose like "created at index 5"). Failure
 *    keywords are the four literals `FAILED`, `AssertionError`,
 *    `TypeError`, `Error`. The karma bootstrap markers in
 *    [src/verify/karma.ts:96](../verify/karma.ts) are not exported; a
 *    V1.4+ refinement could share them.
 * 5. **Prompt-vs-audit asymmetry — load-bearing.** This sanitiser
 *    runs at the prompt site only. The raw karma output is still
 *    written byte-for-byte to
 *    `.sapui5-validator/last-run/verify/<callId>-karma.txt` by the
 *    audit-write path (see
 *    [src/audit/runner.ts:124](../audit/runner.ts) and
 *    [src/verify/pipeline.ts:158](../verify/pipeline.ts)) so a human
 *    debugger always has the full evidence. The asymmetry is by
 *    design and pinned by the AM4 invariant witness.
 *
 * The function is pure: no I/O, no logging, no globals. The
 * orchestrator (retry-loop.ts) is responsible for emitting the
 * `[WARN]` line and bumping the report counter when truncation fires.
 */

import { Buffer } from 'node:buffer';

export const MAX_PROMPT_FEEDBACK_BYTES = 16_384;

export interface PrepareFeedbackResult {
  readonly text: string;
  readonly truncatedBytes: number;
}

const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const KARMA_PROGRESS_RE = /Executed \d+ of \d+/;
const STACK_FRAME_RE = /^\s*at /;
const FAILURE_KEYWORDS = ['FAILED', 'AssertionError', 'TypeError', 'Error'];

type LineKind = 'stack-frame' | 'failure-keyword' | 'other';

function classifyLine(line: string): LineKind {
  if (STACK_FRAME_RE.test(line)) return 'stack-frame';
  for (const kw of FAILURE_KEYWORDS) {
    if (line.includes(kw)) return 'failure-keyword';
  }
  return 'other';
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI_RE, '');
}

/**
 * Drop every karma `Executed N of M` progress line except its last
 * occurrence. Substring-matched (not anchored) so the typical karma
 * prefix (`HeadlessChrome 120.0.0 (Linux): Executed N of M …`) is
 * recognised.
 */
function collapseKarmaProgress(lines: readonly string[]): string[] {
  let lastIx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && KARMA_PROGRESS_RE.test(line)) {
      lastIx = i;
      break;
    }
  }
  if (lastIx === -1) return [...lines];
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (KARMA_PROGRESS_RE.test(line) && i !== lastIx) continue;
    out.push(line);
  }
  return out;
}

/**
 * Take at most `maxBytes` UTF-8 bytes from `s` (head or tail). The
 * slice round-trips through UTF-8 so a multi-byte codepoint is never
 * cut mid-byte — `Buffer.toString('utf8')` drops a trailing partial
 * codepoint cleanly without introducing a `�` replacement char.
 */
function sliceUtf8(s: string, maxBytes: number, fromStart: boolean): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const sub = fromStart ? buf.subarray(0, maxBytes) : buf.subarray(buf.length - maxBytes);
  return sub.toString('utf8');
}

export function prepareFeedbackForPrompt(
  text: string,
  cap: number = MAX_PROMPT_FEEDBACK_BYTES,
): PrepareFeedbackResult {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes === 0) return { text: '', truncatedBytes: 0 };

  const stripped = stripAnsi(text);
  const lines = stripped.split('\n');
  const collapsed = collapseKarmaProgress(lines);
  const normalised = collapsed.join('\n');
  const normalisedBytes = Buffer.byteLength(normalised, 'utf8');

  if (normalisedBytes <= cap) {
    return { text: normalised, truncatedBytes: 0 };
  }

  const headBudget = Math.floor(cap * 0.4);
  const markerBytesPlaceholder = 36; // upper bound for `\n… [truncated <N> bytes] …\n`
  const tailBudget = cap - headBudget - markerBytesPlaceholder;

  const hoistIndices = new Set<number>();
  for (let i = 0; i < collapsed.length; i += 1) {
    const line = collapsed[i] ?? '';
    const kind = classifyLine(line);
    if (kind === 'failure-keyword' || kind === 'stack-frame') {
      hoistIndices.add(i);
    }
  }

  const headLineIndices: number[] = [];
  let headLineBytes = 0;
  for (let i = 0; i < collapsed.length; i += 1) {
    if (hoistIndices.has(i)) break;
    const line = collapsed[i] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const sep = headLineIndices.length > 0 ? 1 : 0;
    if (headLineBytes + lineBytes + sep > headBudget) break;
    headLineIndices.push(i);
    headLineBytes += lineBytes + sep;
  }
  const headBoundary = headLineIndices.length > 0
    ? headLineIndices[headLineIndices.length - 1] ?? -1
    : -1;

  const tailLineIndices: number[] = [];
  let tailLineBytes = 0;
  for (let i = collapsed.length - 1; i > headBoundary; i -= 1) {
    if (hoistIndices.has(i)) break;
    const line = collapsed[i] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const sep = tailLineIndices.length > 0 ? 1 : 0;
    if (tailLineBytes + lineBytes + sep > tailBudget) break;
    tailLineIndices.unshift(i);
    tailLineBytes += lineBytes + sep;
  }

  let headText = headLineIndices.map((i) => collapsed[i] ?? '').join('\n');
  if (headText === '' && collapsed.length > 0 && !hoistIndices.has(0)) {
    headText = sliceUtf8(collapsed[0] ?? '', headBudget, true);
  }

  let tailText = tailLineIndices.map((i) => collapsed[i] ?? '').join('\n');
  if (tailText === '' && collapsed.length > 0) {
    const lastIx = collapsed.length - 1;
    if (!hoistIndices.has(lastIx)) {
      tailText = sliceUtf8(collapsed[lastIx] ?? '', tailBudget, false);
    }
  }

  const headBytesActual = Buffer.byteLength(headText, 'utf8');
  const tailBytesActual = Buffer.byteLength(tailText, 'utf8');

  // B2 (V1.5): budget the hoisted block too. When every line is hoist-eligible
  // (a deep stack where each line is a frame / Error keyword), the head and tail
  // loops break on the first line and come back empty, so an UNBOUNDED hoisted
  // block flowed straight into the output — re-opening the Windows argv overflow
  // this function exists to prevent. Keep hoisted lines in document order (the
  // failure-keyword line and the TOP stack frames are the highest-value signal)
  // up to the bytes left after head, tail, and a generous marker allowance, so
  // the total is provably <= cap.
  const MARKER_BYTES_UPPER_BOUND = 64;
  const hoistBudget = Math.max(
    0,
    cap - headBytesActual - tailBytesActual - MARKER_BYTES_UPPER_BOUND,
  );
  const hoistedLines: string[] = [];
  let hoistedLineBytes = 0;
  for (const i of hoistIndices) {
    if (headLineIndices.includes(i) || tailLineIndices.includes(i)) continue;
    const line = collapsed[i] ?? '';
    const sep = hoistedLines.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (hoistedLineBytes + lineBytes + sep > hoistBudget) break;
    hoistedLines.push(line);
    hoistedLineBytes += lineBytes + sep;
  }

  const hoistedBlock = hoistedLines.length > 0 ? `${hoistedLines.join('\n')}\n` : '';
  const hoistedBytesActual = Buffer.byteLength(hoistedBlock, 'utf8');

  const provisionalDropped = Math.max(
    0,
    normalisedBytes - headBytesActual - tailBytesActual - hoistedBytesActual,
  );
  const marker = `\n… [truncated ${provisionalDropped} bytes] …\n`;
  let finalText = `${headText}${marker}${hoistedBlock}${tailText}`;
  let outputBytes = Buffer.byteLength(finalText, 'utf8');

  if (outputBytes > cap) {
    // The budgets above keep the total under `cap`; this is a belt-and-braces
    // net for a pathological marker / multi-byte boundary. Trim the tail first
    // (head + failure hoist are the load-bearing signal), then hard-bound the
    // whole result so the byte ceiling is an absolute guarantee.
    const over = outputBytes - cap;
    const trimmedTail = sliceUtf8(tailText, Math.max(0, tailBytesActual - over), false);
    finalText = `${headText}${marker}${hoistedBlock}${trimmedTail}`;
    outputBytes = Buffer.byteLength(finalText, 'utf8');
    if (outputBytes > cap) {
      finalText = sliceUtf8(finalText, cap, true);
      outputBytes = Buffer.byteLength(finalText, 'utf8');
    }
  }

  return {
    text: finalText,
    truncatedBytes: originalBytes - outputBytes,
  };
}
