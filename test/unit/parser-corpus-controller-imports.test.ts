/**
 * V1.9.5 INF-4 — golden parser corpus for `parseControllerImports` /
 * `parseEsModuleImports` over `test/fixtures/parser-corpus/controller-imports/`.
 *
 * The corpus pins CURRENT behavior (see the corpus README's append-on-incident
 * rule): every future parser incident adds its input file + a table row here in
 * the same commit as the fix. Rows marked KNOWN LIMITATION pin an OPEN gap —
 * fixing the gap must flip that row deliberately.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseControllerImports,
  parseEsModuleImports,
} from '../../src/project/controller-imports.js';

const CORPUS_DIR = join(
  process.cwd(),
  'test',
  'fixtures',
  'parser-corpus',
  'controller-imports',
);

/** Fixture-integrity trait the corpus file must genuinely carry (a silently
 * normalized fixture would otherwise defuse the case it exists for). */
type EncodingTrait = 'bom' | 'crlf';

interface ControllerImportsCase {
  readonly corpusFile: string;
  readonly title: string;
  readonly parser: 'amd' | 'es';
  readonly expected: readonly string[];
  readonly encoding?: EncodingTrait;
}

const CASES: readonly ControllerImportsCase[] = [
  {
    corpusFile: 'v1_4-11-commented-define.js',
    title: 'V1.4-11 — commented-out / JSDoc-@example define above the live one does not hijack',
    parser: 'amd',
    expected: ['sap/ui/core/mvc/Controller', 'sap/m/Button'],
  },
  {
    corpusFile: 'cor-5-regex-define-head.js',
    title: 'COR-5 — a `sap.ui.define([` inside a regex literal fabricates no phantom imports',
    parser: 'amd',
    expected: [],
  },
  {
    // KNOWN LIMITATION (V1.5 #A2, OPEN): the named `sap.ui.define("id", [...])`
    // form is missed by the head regex; the real 'dep/a' import is dropped.
    // Fixing #A2 must flip this pin to ['dep/a'].
    corpusFile: 'a2-named-define.js',
    title: 'V1.5 #A2 KNOWN LIMITATION — named define yields zero imports (pinned)',
    parser: 'amd',
    expected: [],
  },
  {
    // Pinned truncation (V1.5 #A6): only the FIRST array-form define is parsed;
    // multi-define support is an undecided product question.
    corpusFile: 'a6-two-defines.js',
    title: 'V1.5 #A6 — two defines: only the first define array is parsed (pinned truncation)',
    parser: 'amd',
    expected: ['sap/m/Button'],
  },
  {
    // GA1-03 inertness half: the AMD parser finds no head in a TS controller.
    corpusFile: 'ga1-03-ts-es-imports.ts',
    title: 'GA1-03 — the AMD parser is inert ([]) on a TS ES-module controller',
    parser: 'amd',
    expected: [],
  },
  {
    corpusFile: 'ga1-03-ts-es-imports.ts',
    title: 'GA1-03 — ES parser: default/named/namespace/side-effect kept; relative + type-only excluded',
    parser: 'es',
    expected: [
      'sap/ui/core/mvc/Controller',
      'sap/m/library',
      'sap/ui/core/library',
      'sap/ui/core/sample/SideEffect',
    ],
  },
  {
    // KNOWN LIMITATION (adversarial, pinned observation 2026-07-03): a template
    // literal carrying `sap.ui.define(["fake/dep"], ...)` TEXT above the real
    // define HIJACKS the head search — template contents survive comment-
    // masking, so the parser returns the phantom 'fake/dep' and DROPS the real
    // 'sap/m/Text'. Same class as pre-COR-5 regex bodies, unfixed for template
    // literals. A fix must flip this pin to ['sap/m/Text'].
    corpusFile: 'adv-template-literal-define.js',
    title: 'adversarial KNOWN LIMITATION — template-literal define text above the real define wins (phantom import, pinned)',
    parser: 'amd',
    expected: ['fake/dep'],
  },
  {
    // Pinned observation: a leading UTF-8 BOM is harmless to the AMD parser.
    corpusFile: 'adv-bom-define.js',
    title: 'adversarial — UTF-8 BOM prefix does not disturb the AMD parse',
    parser: 'amd',
    expected: ['sap/m/Button'],
    encoding: 'bom',
  },
  {
    // Pinned observation: CRLF line endings are harmless to the AMD parser.
    corpusFile: 'adv-crlf-define.js',
    title: 'adversarial — CRLF line endings do not disturb the AMD parse',
    parser: 'amd',
    expected: ['sap/ui/core/mvc/Controller', 'sap/m/Button'],
    encoding: 'crlf',
  },
  {
    // Pinned observation: balanced nested backticks near the define are
    // harmless — the masker's naive backtick toggle happens to re-close.
    corpusFile: 'adv-nested-backticks.js',
    title: 'adversarial — nested template literals near the define leave the parse intact',
    parser: 'amd',
    expected: ['sap/m/Text'],
  },
  {
    // Pinned observation: commented-out ES imports never parse.
    corpusFile: 'adv-comment-import.ts',
    title: 'adversarial — a commented-out ES import does not parse',
    parser: 'es',
    expected: ['sap/ui/core/mvc/Controller'],
  },
];

function assertEncodingTrait(content: string, trait: EncodingTrait): void {
  if (trait === 'bom') {
    expect(content.charCodeAt(0)).toBe(0xfeff);
  } else {
    expect(content).toContain('\r\n');
  }
}

describe('parser corpus — controller-imports (INF-4)', () => {
  for (const c of CASES) {
    test(`${c.corpusFile} [${c.parser}] — ${c.title}`, () => {
      const content = readFileSync(join(CORPUS_DIR, c.corpusFile), 'utf8');
      if (c.encoding !== undefined) assertEncodingTrait(content, c.encoding);
      const result =
        c.parser === 'amd' ? parseControllerImports(content) : parseEsModuleImports(content);
      expect(result).toEqual(c.expected);
    });
  }
});
