/**
 * V1.3.2-2 witness — pins the V1.3.2-3 contract for
 * `prepareFeedbackForPrompt`. Most cases here fail against V1.3.2-2's
 * identity stub with specific assertion mismatches (AH5); the boundary
 * cases (empty input, input at the cap, ASCII below the cap) pass
 * against the stub and document the no-op edges of the contract.
 *
 * V1.3.2-3 turns the failing witnesses green by implementing the real
 * sanitiser (ANSI strip, karma progress-line collapse, per-line
 * classification with AH2 anchored `/^\s*at /` stack-frame matching,
 * AH6 mid-input never-drop hoisting, AH1 40% head / 60% tail
 * truncation with byte-accurate accounting).
 */

import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import {
  MAX_PROMPT_FEEDBACK_BYTES,
  prepareFeedbackForPrompt,
} from '../../src/util/prompt-feedback.js';

const ESC = '';

describe('prepareFeedbackForPrompt — contract pinned for V1.3.2-3', () => {
  test('empty input returns empty text with zero truncated bytes', () => {
    const result = prepareFeedbackForPrompt('');
    expect(result.text).toBe('');
    expect(result.truncatedBytes).toBe(0);
  });

  test('exported MAX_PROMPT_FEEDBACK_BYTES equals 16_384 (AP1 — 16 KiB exact)', () => {
    expect(MAX_PROMPT_FEEDBACK_BYTES).toBe(16_384);
  });

  test('small ANSI-decorated input strips CSI sequences, no head/tail truncation', () => {
    const ansiInput = `${ESC}[31mERROR${ESC}[0m: a thing went wrong\n${ESC}[1;33mWARN${ESC}[0m: another\n`;
    const result = prepareFeedbackForPrompt(ansiInput);

    // ANSI CSI sequences are stripped from the output.
    expect(result.text).not.toContain(ESC);
    expect(result.text).not.toMatch(/\x1b\[[0-9;]*[A-Za-z]/u);
    // Visible content is preserved.
    expect(result.text).toContain('ERROR: a thing went wrong');
    expect(result.text).toContain('WARN: another');
    // No head/tail eviction took place — well under the cap.
    expect(result.truncatedBytes).toBe(0);
  });

  test('karma per-test "Executed N of M" progress lines collapse, keeping the final one', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 50; i += 1) {
      lines.push(`HeadlessChrome 120.0.0 (Linux): Executed ${i} of 50 SUCCESS (0 secs / 0 secs)`);
    }
    lines.push('TOTAL: 50 SUCCESS');
    const input = `${lines.join('\n')}\n`;
    const result = prepareFeedbackForPrompt(input);

    const progressMatches = result.text.match(/Executed \d+ of \d+/g) ?? [];
    // All but the final progress line must be dropped — the witness pins the
    // last-occurrence rule so the LLM still sees the total count.
    expect(progressMatches.length).toBe(1);
    expect(progressMatches[0]).toBe('Executed 50 of 50');
    expect(result.text).toContain('TOTAL: 50 SUCCESS');
  });

  test('AH6 — a middle-of-input FAILED line survives, and middle progress noise is dropped', () => {
    // Payload shape: <5KB bootstrap>\n<10KB progress>\nFAILED: AssertionError\n
    // <10KB progress>\n<5KB summary>. The stub returns the input unchanged;
    // FAILED appears, but the 200+ progress lines also appear → fails the
    // "progress lines were dropped" assertion.
    const bootstrap = 'BOOTSTRAP_LINE '.repeat(320) + '\n'; // ~5 KB
    const summary = 'SUMMARY_LINE '.repeat(320) + '\n'; // ~5 KB
    const progressChunk = Array.from({ length: 110 }, (_, i) => {
      const n = i + 1;
      return `HeadlessChrome: Executed ${n} of 220 SUCCESS (0 secs / 0 secs)`;
    }).join('\n');
    const middleStackFrame = '    at AppController.onInit (webapp/controller/App.controller.js:42:9)';
    const input =
      `${bootstrap}${progressChunk}\n` +
      'FAILED: AssertionError — expected 1 to be 0\n' +
      `${middleStackFrame}\n` +
      `${progressChunk.replace(/Executed (\d+) of 220/g, (_, n: string) => `Executed ${Number(n) + 110} of 220`)}\n` +
      `${summary}`;

    const result = prepareFeedbackForPrompt(input);

    // AH6: the middle FAILED line is preserved (hoisted into the tail half).
    expect(result.text).toContain('FAILED: AssertionError');
    // AH6: the middle stack-frame survives too.
    expect(result.text).toContain(middleStackFrame);
    // The progress lines are collapsed — at most one "Executed N of 220" line
    // remains, matching the karma-progress-collapse rule. Stub keeps all 220
    // (well within input) and fails this guard.
    const progressMatches = result.text.match(/Executed \d+ of 220/g) ?? [];
    expect(progressMatches.length).toBeLessThanOrEqual(1);
  });

  test('AH2 — anchored /^\\s*at / matches stack frames; substring "at " on other lines is incidental', () => {
    // Build an oversized input (forces head/tail truncation) where the
    // load-bearing lines sit in the middle. With AH2's anchored classifier,
    // the genuine stack frame is hoisted and survives; the "created at index"
    // line — incidental "at " in prose — is regular middle content and is
    // evicted from the head/tail margins.
    const padHead = 'HEAD_PAD '.repeat(1024) + '\n'; // ~9 KB
    const padTail = 'TAIL_PAD '.repeat(1024) + '\n'; // ~9 KB
    const genuineFrame = '    at AppController.onInit (webapp/controller/App.controller.js:42:9)';
    const incidentalAt = 'Element was created at index 5 of the bound aggregation.';
    const input = `${padHead}${incidentalAt}\n${genuineFrame}\n${padTail}`;

    const result = prepareFeedbackForPrompt(input);

    // Truncation fired (input is well above the cap).
    expect(result.truncatedBytes).toBeGreaterThan(0);
    // Genuine stack-frame line is preserved (hoisted via failure-keyword /
    // stack-frame classification).
    expect(result.text).toContain(genuineFrame);
    // Incidental "at " line is NOT preserved — the substring `at ` must not
    // qualify the line as a stack frame.
    expect(result.text).not.toContain(incidentalAt);
  });

  test('oversized ASCII input → head+tail truncation with elision marker; head < tail (AH1 40/60)', () => {
    // ASCII-only so .length === Buffer.byteLength. No ANSI, no progress
    // lines, no failure keywords → the only transformation is head/tail
    // truncation, so `truncatedBytes === originalBytes - outputBytes`.
    const headLines = Array.from({ length: 500 }, (_, i) => `HEAD ${String(i).padStart(4, '0')}`);
    const tailLines = Array.from({ length: 1500 }, (_, i) => `TAIL ${String(i).padStart(4, '0')}`);
    const input = `${headLines.join('\n')}\n${tailLines.join('\n')}\n`;
    const originalBytes = Buffer.byteLength(input, 'utf8');
    expect(originalBytes).toBeGreaterThan(MAX_PROMPT_FEEDBACK_BYTES);

    const result = prepareFeedbackForPrompt(input);
    const outputBytes = Buffer.byteLength(result.text, 'utf8');

    // Output stays under the cap.
    expect(outputBytes).toBeLessThanOrEqual(MAX_PROMPT_FEEDBACK_BYTES);
    // Elision marker landed between head and tail.
    expect(result.text).toMatch(/\n… \[truncated \d+ bytes\] …\n/u);
    // Both ends preserved (head leading lines + tail trailing lines).
    expect(result.text).toContain('HEAD 0000');
    expect(result.text.endsWith('TAIL 1499\n') || result.text.includes('TAIL 1499')).toBe(true);
    // AH1: tail favoured (the failure block sits in the tail half of karma
    // output). Tail-half byte count > head-half byte count.
    const markerMatch = result.text.match(/\n… \[truncated \d+ bytes\] …\n/u);
    expect(markerMatch).not.toBeNull();
    if (markerMatch !== null) {
      const markerIx = result.text.indexOf(markerMatch[0]);
      const headBytes = Buffer.byteLength(result.text.slice(0, markerIx), 'utf8');
      const tailBytes = Buffer.byteLength(result.text.slice(markerIx + markerMatch[0].length), 'utf8');
      expect(tailBytes).toBeGreaterThan(headBytes);
    }
    // Byte accounting: truncatedBytes equals (original − output) when no
    // pre-truncation normalisation fires.
    expect(result.truncatedBytes).toBe(originalBytes - outputBytes);
  });

  test('boundary triplet: cap-sized input is untouched; cap+1 triggers truncation', () => {
    const atCap = 'a'.repeat(MAX_PROMPT_FEEDBACK_BYTES);
    const justBelow = 'a'.repeat(MAX_PROMPT_FEEDBACK_BYTES - 1);
    const justAbove = 'a'.repeat(MAX_PROMPT_FEEDBACK_BYTES + 1);

    const atResult = prepareFeedbackForPrompt(atCap);
    const belowResult = prepareFeedbackForPrompt(justBelow);
    const aboveResult = prepareFeedbackForPrompt(justAbove);

    // At and below the cap → no truncation.
    expect(atResult.truncatedBytes).toBe(0);
    expect(belowResult.truncatedBytes).toBe(0);
    // Above the cap → truncation, elision marker landed.
    expect(aboveResult.truncatedBytes).toBeGreaterThan(0);
    expect(aboveResult.text).toMatch(/\n… \[truncated \d+ bytes\] …\n/u);
    expect(Buffer.byteLength(aboveResult.text, 'utf8')).toBeLessThanOrEqual(
      MAX_PROMPT_FEEDBACK_BYTES,
    );
  });

  test('UTF-8 safety: output is valid UTF-8 even when a 4-byte emoji straddles the head/tail boundary', () => {
    // Place a 4-byte emoji near the byte midpoint so head+tail truncation
    // must split the input near it. Pad on both sides to force truncation.
    const emoji = '😀'; // U+1F600, 4 bytes in UTF-8.
    const sidePad = 'p'.repeat(MAX_PROMPT_FEEDBACK_BYTES); // each side > cap
    const input = `${sidePad}${emoji}${sidePad}`;

    const result = prepareFeedbackForPrompt(input);

    // The output round-trips through UTF-8 cleanly — no replacement char
    // introduced by a mid-codepoint cut. (V1.3.2-3 must use Buffer.byteLength
    // and split on character boundaries; the stub passes this trivially since
    // it returns the input unchanged, which is already valid UTF-8.)
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text);
    expect(result.text).not.toContain('�');
  });
});
