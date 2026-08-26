/**
 * V1.4-5 (AH5) — dedicated snapshot witness for the strengthened
 * `SYSTEM_PROMPT` at `src/checks/_shared.ts`.
 *
 * The constant is imported by seven check prompts AND both
 * generation prompts; an edit cascades silently through many
 * snapshots. This single-purpose witness is the canonical pin:
 * any intentional drift updates ONE snapshot here (with a one-line
 * justification in the commit message); any accidental drift fails
 * loudly on `npm test`.
 *
 * Pairs with `test/unit/system-prompt-negatives.test.ts`, which
 * asserts the load-bearing DO / rejected-shape phrases by substring.
 */

import { describe, expect, test } from 'vitest';
import { SYSTEM_PROMPT } from '../../src/checks/_shared.js';

describe('SYSTEM_PROMPT (V1.4-5)', () => {
  test('byte-for-byte snapshot', () => {
    // R1.7c (AUDIT §5.7b): the acceptable examples now show one shape per
    // call class — the checks' {"findings":[...]} envelope AND the
    // generator's {"newFileContent":...} — instead of the generator shape
    // only, which mis-steered the seven check prompts.
    expect(SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "You are a static-analysis assistant for SAPUI5 (JavaScript) projects.
      Follow instructions exactly. Respond with a SINGLE JSON value matching the requested schema.

      Acceptable responses (the JSON value alone, no surrounding text):
        {"findings":[]}
        {"newFileContent":"sap.ui.define([], function(){});"}

      Rejected shapes (the parser refuses these):
        Prefixing with prose:    The issue: foo bar. {"newFileContent":"..."}
        Wrapping in fences:      (three backticks)json {"newFileContent":"..."} (three backticks)
        Trailing commentary:     {"newFileContent":"..."} // hope this helps

      If you have thinking you want to share, omit it. The downstream system reads only the JSON value."
    `);
  });

  test('Acceptable / Rejected markers are present', () => {
    expect(SYSTEM_PROMPT).toContain('Acceptable responses (the JSON value alone, no surrounding text):');
    expect(SYSTEM_PROMPT).toContain('Rejected shapes (the parser refuses these):');
  });

  test('R1.7c — the acceptable examples cover BOTH call classes', () => {
    // The checks answer with the findings envelope; generation answers with
    // newFileContent. Each must appear as an acceptable example so neither
    // call class is steered toward the other's shape.
    expect(SYSTEM_PROMPT).toContain('{"findings":[]}');
    expect(SYSTEM_PROMPT).toContain('{"newFileContent":"sap.ui.define([], function(){});"}');
  });

  test('each rejected-shape line is present (the three-of-three contract)', () => {
    // V1.3.3-4 Bug A — the prose-preamble case the strengthened
    // prompt is meant to bind away from.
    expect(SYSTEM_PROMPT).toContain('Prefixing with prose:');
    // V1.3.3 backlog §4.3 — markdown-fenced JSON. The literal
    // backticks are intentionally referred to as "(three backticks)"
    // because frontier models DO parse fenced content as a code
    // block boundary and would read a literal-fenced negative
    // example as a sanctioned shape (AH4).
    expect(SYSTEM_PROMPT).toContain('Wrapping in fences:');
    expect(SYSTEM_PROMPT).toContain('(three backticks)');
    // Trailing prose / commentary — observed in earlier real runs.
    expect(SYSTEM_PROMPT).toContain('Trailing commentary:');
  });

  test('AH4 — no literal markdown fences anywhere in the prompt body', () => {
    // The literal triple-backtick character sequence MUST NOT
    // appear in the prompt: a frontier model would treat it as a
    // sanctioned code-block boundary. The negative examples use
    // the "(three backticks)" textual reference instead.
    expect(SYSTEM_PROMPT.includes('```')).toBe(false);
  });

  test('SINGLE-JSON-value framing is present', () => {
    // The legacy prompt said "a single JSON value"; the strengthened
    // version emphasises with caps to bind harder against the
    // multi-block shape V1.3.3-4 reserved an extractor for.
    expect(SYSTEM_PROMPT).toContain('SINGLE JSON value');
  });
});
