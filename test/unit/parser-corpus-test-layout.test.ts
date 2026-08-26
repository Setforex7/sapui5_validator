/**
 * V1.9.5 INF-4 — golden parser corpus for the test-layout parsers over
 * `test/fixtures/parser-corpus/test-layout/`.
 *
 * The corpus pins CURRENT behavior (see the corpus README's append-on-incident
 * rule). String parsers (`parseKarmaClientLibs` / `parseKarmaUi5Url`) read the
 * corpus content directly; directory-shaped parsers materialize the corpus
 * string into a fresh tmpdir sandbox per case (the corpus tree itself is
 * READ-ONLY at test time — never write into it).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  FALLBACK_LAYOUT,
  detectTestLayout,
  parseKarmaClientLibs,
  parseKarmaConfig,
  parseKarmaUi5Url,
  parseTestSuiteHtml,
  resolveQUnitRoot,
} from '../../src/project/test-layout.js';

const CORPUS_DIR = join(process.cwd(), 'test', 'fixtures', 'parser-corpus', 'test-layout');

function readCorpus(corpusFile: string): string {
  return readFileSync(join(CORPUS_DIR, corpusFile), 'utf8');
}

type EncodingTrait = 'bom' | 'crlf';

interface KarmaStringCase {
  readonly corpusFile: string;
  readonly title: string;
  readonly expectedLibs: readonly string[];
  readonly expectedUrl: string | null;
  readonly encoding?: EncodingTrait;
}

const STRING_CASES: readonly KarmaStringCase[] = [
  {
    corpusFile: 'cor-10-nested-client.karma.txt',
    title: 'COR-10 — a nested sibling object inside `client` before `libs` no longer hides it',
    expectedLibs: ['sap.m', 'sap.f'],
    expectedUrl: null,
  },
  {
    corpusFile: 'a3-nested-ui5-url.karma.txt',
    title: 'A3 — a `paths` sibling object before `ui5.url` no longer hides the url',
    expectedLibs: [],
    expectedUrl: 'https://sdk.openui5.org',
  },
  {
    // Pinned observation: a leading UTF-8 BOM is harmless to both string parsers.
    corpusFile: 'adv-bom.karma.txt',
    title: 'adversarial — BOM-prefixed karma config: libs and url both parse',
    expectedLibs: ['sap.m'],
    expectedUrl: 'https://sdk.openui5.org',
    encoding: 'bom',
  },
  {
    // Pinned observation: CRLF endings are harmless; the commented-out decoy
    // `client: { libs: ['sap.decoy'] }` line is masked and ignored.
    corpusFile: 'adv-crlf.karma.txt',
    title: 'adversarial — CRLF karma config: libs and url both parse, commented decoy ignored',
    expectedLibs: ['sap.m', 'sap.f'],
    expectedUrl: 'https://ui5.sap.com',
    encoding: 'crlf',
  },
];

describe('parser corpus — test-layout string parsers (INF-4)', () => {
  for (const c of STRING_CASES) {
    test(`${c.corpusFile} — ${c.title}`, () => {
      const content = readCorpus(c.corpusFile);
      if (c.encoding === 'bom') expect(content.charCodeAt(0)).toBe(0xfeff);
      if (c.encoding === 'crlf') expect(content).toContain('\r\n');
      expect(parseKarmaClientLibs(content)).toEqual(c.expectedLibs);
      expect(parseKarmaUi5Url(content)).toBe(c.expectedUrl);
    });
  }
});

describe('parser corpus — test-layout directory-shaped parsers (INF-4)', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'parser-corpus-layout-'));
  });

  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('f4-glob-charclass.karma.txt — F4: a comment `]` and a `[abc]` char-class glob both survive', () => {
    writeFileSync(join(root, 'karma.conf.js'), readCorpus('f4-glob-charclass.karma.txt'), 'utf8');
    const result = parseKarmaConfig(root);
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.testFileGlobs).toEqual([
      'webapp/test/[abc]/**/*.qunit.js',
      'webapp/test/integration/**/*.qunit.js',
    ]);
  });

  test('ga1-08-qunit-ts-glob.karma.txt — GA1-08: a `.qunit.ts` glob resolves the QUnit root from config', () => {
    writeFileSync(join(root, 'karma.conf.js'), readCorpus('ga1-08-qunit-ts-glob.karma.txt'), 'utf8');
    const layout = detectTestLayout(root);
    expect(layout.inferredFrom).toBe('config');
    expect(resolveQUnitRoot(layout)).toBe('webapp/qunit');
    expect(resolveQUnitRoot(layout)).not.toBe(FALLBACK_LAYOUT.qunit);
  });

  test('suite-crlf.testsuite.html — a CRLF testsuite.qunit.html still yields its <a href> module entry', () => {
    const content = readCorpus('suite-crlf.testsuite.html');
    expect(content).toContain('\r\n'); // fixture-integrity guard: CRLF must survive in the corpus
    mkdirSync(join(root, 'webapp', 'test'), { recursive: true });
    writeFileSync(join(root, 'webapp', 'test', 'testsuite.qunit.html'), content, 'utf8');
    const result = parseTestSuiteHtml(root);
    expect(result).toBeDefined();
    expect(result?.entries).toEqual(['unit/unit.qunit.html']);
  });
});
