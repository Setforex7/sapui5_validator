/**
 * V1.9.5 INF-4 — golden parser corpus for `stripJsComments` over
 * `test/fixtures/parser-corpus/strip-js-comments/`.
 *
 * The corpus pins CURRENT behavior (see the corpus README's append-on-incident
 * rule). Expectations are PROPERTY assertions (length preservation +
 * mustStillContain / mustNotContain) rather than full golden strings, per the
 * masker's contract. Rows marked KNOWN LIMITATION pin a documented residual —
 * fixing it must flip the row deliberately.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { stripJsComments } from '../../src/util/strip-js-comments.js';

const CORPUS_DIR = join(
  process.cwd(),
  'test',
  'fixtures',
  'parser-corpus',
  'strip-js-comments',
);

type EncodingTrait = 'bom' | 'crlf';

interface StripCase {
  readonly corpusFile: string;
  readonly title: string;
  readonly options?: { readonly maskRegexLiterals: boolean };
  readonly mustStillContain: readonly string[];
  readonly mustNotContain: readonly string[];
  readonly encoding?: EncodingTrait;
  /** Pinned observation: how many `\r` bytes survive masking (line-comment
   * masking blanks a `\r` that sits inside the comment span). */
  readonly carriageReturns?: { readonly input: number; readonly output: number };
  /** Pinned observation: a leading BOM passes through to the output. */
  readonly outputKeepsBom?: boolean;
}

const CASES: readonly StripCase[] = [
  {
    corpusFile: 'a4-regex-quote.js',
    title: 'A4 — a regex literal containing a quote keeps the code and strips the trailing comment',
    mustStillContain: ["/(['\"])/", 'var keep = 1;'],
    mustNotContain: ['tail comment swallowed'],
  },
  {
    // KNOWN LIMITATION (V1.9 GA1-09 residual, pinned observation 2026-07-03):
    // the newline-leading `/` after the generic-closing `>` is misread as a
    // regex START; the "regex" scan consumes ` 2; ` and closes on the first `/`
    // of `//`, so the trailing comment LEAKS unmasked (`/ 2; // tail` survives
    // verbatim). Length preservation still holds. A type-aware lexer fix must
    // flip this row so `tail` lands in mustNotContain.
    corpusFile: 'ga1-09-generic-division.ts',
    title: 'GA1-09 KNOWN LIMITATION — `/` after a generic-closing `>` leaks the trailing comment (pinned residual)',
    mustStillContain: ['pick<Map<string, number>>', '/ 2; // tail', 'const keep = 1;'],
    mustNotContain: ['GA1-09 residual'],
  },
  {
    // Pinned observation: the BOM passes through untouched and the `//` right
    // after it still masks; length preservation counts the BOM as one char.
    corpusFile: 'adv-bom.js',
    title: 'adversarial — BOM prefix: comments still masked, BOM survives in the output',
    mustStillContain: ['var x = 1;'],
    mustNotContain: ['leading comment', 'tail'],
    encoding: 'bom',
    outputKeepsBom: true,
  },
  {
    // Pinned observation: line-comment masking blanks EVERY char up to the
    // `\n` — including the `\r` of a CRLF pair — so comment-terminated lines
    // lose their CR (3 CRs in, 1 CR out; only the comment-free `var c` line
    // keeps its `\r\n`). Length is still preserved (the CR becomes a space).
    corpusFile: 'adv-crlf.js',
    title: 'adversarial — CRLF source: comments masked; the CR inside a line-comment span is blanked',
    mustStillContain: ['var a = 1;', 'var b = 2;', 'var c = 3;\r\n'],
    mustNotContain: ['line comment', 'block', 'tail'],
    encoding: 'crlf',
    carriageReturns: { input: 3, output: 1 },
  },
  {
    // Pinned observation: balanced nested backticks re-close the masker's
    // naive backtick toggle, so the template survives verbatim and both the
    // header and tail comments are still masked.
    corpusFile: 'adv-nested-backticks.js',
    title: 'adversarial — nested template literals: template kept verbatim, surrounding comments masked',
    mustStillContain: ['`outer ${ `inner` } outer`', 'sap.ui.define(["sap/m/Text"], function (Text) {'],
    mustNotContain: ['tail comment after the define', 'naive toggle'],
  },
];

function countCarriageReturns(s: string): number {
  return (s.match(/\r/g) ?? []).length;
}

describe('parser corpus — strip-js-comments (INF-4)', () => {
  for (const c of CASES) {
    test(`${c.corpusFile} — ${c.title}`, () => {
      const content = readFileSync(join(CORPUS_DIR, c.corpusFile), 'utf8');
      if (c.encoding === 'bom') expect(content.charCodeAt(0)).toBe(0xfeff);
      if (c.encoding === 'crlf') expect(content).toContain('\r\n');
      const out =
        c.options === undefined
          ? stripJsComments(content)
          : stripJsComments(content, c.options);
      // The masker's core contract: length-preserving, always.
      expect(out).toHaveLength(content.length);
      for (const needle of c.mustStillContain) expect(out).toContain(needle);
      for (const needle of c.mustNotContain) expect(out).not.toContain(needle);
      if (c.carriageReturns !== undefined) {
        expect(countCarriageReturns(content)).toBe(c.carriageReturns.input);
        expect(countCarriageReturns(out)).toBe(c.carriageReturns.output);
      }
      if (c.outputKeepsBom === true) expect(out.charCodeAt(0)).toBe(0xfeff);
    });
  }
});
