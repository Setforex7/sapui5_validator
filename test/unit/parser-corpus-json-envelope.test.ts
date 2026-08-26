/**
 * V1.9.5 INF-4 — golden parser corpus for `extractJsonValue` over
 * `test/fixtures/parser-corpus/json-envelope/`.
 *
 * The corpus pins CURRENT behavior (see the corpus README's append-on-incident
 * rule): every future envelope incident adds its input file + a table row here
 * in the same commit as the fix. Preamble/jsonText expectations are exact —
 * the corpus-local `.gitattributes` (`* -text`) keeps the fixture bytes stable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractJsonValue,
  JsonExtractionError,
} from '../../src/util/json-envelope.js';

const CORPUS_DIR = join(process.cwd(), 'test', 'fixtures', 'parser-corpus', 'json-envelope');

type EncodingTrait = 'bom' | 'crlf';

type EnvelopeExpectation =
  | {
      readonly kind: 'recovered';
      readonly json: unknown;
      readonly preamble: string;
      readonly jsonText: string;
    }
  | { readonly kind: 'throws'; readonly messageIncludes: string };

interface EnvelopeCase {
  readonly corpusFile: string;
  readonly title: string;
  readonly expectation: EnvelopeExpectation;
  readonly encoding?: EncodingTrait;
}

const CASES: readonly EnvelopeCase[] = [
  {
    corpusFile: 'v1_3_3-prose-preamble.txt',
    title: 'V1.3.3 Bug A — prose preamble + balanced object recovers (cap_try Shop shape)',
    expectation: {
      kind: 'recovered',
      json: { newFileContent: 'sap.ui.define([],function(){});' },
      preamble: 'The issue: controller-module-id mismatch.\n\n',
      jsonText: '{"newFileContent":"sap.ui.define([],function(){});"}',
    },
  },
  {
    corpusFile: 'fenced-json.txt',
    title: 'AC1 — a ```json fenced block is refused with the pinned message',
    expectation: {
      kind: 'throws',
      messageIncludes: 'fenced code block; refusing to strip fences',
    },
  },
  {
    // Pinned observation (2026-07-03): a leading UTF-8 BOM makes the happy-path
    // JSON.parse fail, and recovery treats the BOM itself as the (non-empty)
    // preamble — the JSON still parses. The BOM survives verbatim in `preamble`.
    corpusFile: 'adv-bom-json.txt',
    title: 'adversarial — BOM + JSON recovers with the BOM as the preamble',
    expectation: {
      kind: 'recovered',
      json: { ok: true },
      preamble: '﻿',
      jsonText: '{"ok":true}',
    },
    encoding: 'bom',
  },
  {
    // Pinned observation: CRLF prose recovers; the preamble keeps its \r\n
    // bytes verbatim and the trailing CRLF after the JSON is discarded.
    corpusFile: 'adv-crlf-json.txt',
    title: 'adversarial — CRLF prose preamble + JSON recovers with \\r\\n kept in the preamble',
    expectation: {
      kind: 'recovered',
      json: { applied: true, note: 'crlf' },
      preamble: 'Applying the fix now.\r\n\r\n',
      jsonText: '{"applied":true,"note":"crlf"}',
    },
    encoding: 'crlf',
  },
];

function assertEncodingTrait(content: string, trait: EncodingTrait): void {
  if (trait === 'bom') {
    expect(content.charCodeAt(0)).toBe(0xfeff);
  } else {
    expect(content).toContain('\r\n');
  }
}

describe('parser corpus — json-envelope (INF-4)', () => {
  for (const c of CASES) {
    test(`${c.corpusFile} — ${c.title}`, () => {
      const content = readFileSync(join(CORPUS_DIR, c.corpusFile), 'utf8');
      if (c.encoding !== undefined) assertEncodingTrait(content, c.encoding);
      if (c.expectation.kind === 'throws') {
        const { messageIncludes } = c.expectation;
        expect(() => extractJsonValue(content)).toThrow(JsonExtractionError);
        expect(() => extractJsonValue(content)).toThrow(messageIncludes);
        return;
      }
      const result = extractJsonValue(content);
      expect(result.json).toEqual(c.expectation.json);
      expect(result.preamble).toBe(c.expectation.preamble);
      expect(result.jsonText).toBe(c.expectation.jsonText);
    });
  }
});
