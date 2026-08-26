/**
 * SPEC §2.7 — detect test layout from karma.conf.{js,ts,cjs,mjs} and/or
 * webapp/test/testsuite.qunit.html. We use tolerant regex parsing rather
 * than executing arbitrary karma config or pulling in an HTML parser:
 *
 *  - karma config:    extract the `files: [...]` array body, then collect
 *                     every quoted string literal inside it.
 *  - testsuite.html:  collect every `href="..."` from `<a>` tags.
 *
 * Either source missing is fine — the CLI falls back to the standard
 * SAPUI5 layout. Whether enough information was inferred to resolve a
 * specific test path is a downstream concern (per §2.7 "exit non-zero if
 * unambiguous resolution fails") and lives in later session code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripJsComments } from '../util/strip-js-comments.js';
import { findMatchingDelimiter } from '../util/balance-scan.js';

export interface KarmaConfigResult {
  readonly path: string;
  readonly testFileGlobs: readonly string[];
}

export interface TestSuiteHtmlResult {
  readonly path: string;
  readonly entries: readonly string[];
}

export interface TestLayoutFallback {
  readonly qunit: string;
  readonly opa5: string;
}

export type LayoutInference = 'config' | 'fallback';

export interface TestLayout {
  readonly inferredFrom: LayoutInference;
  readonly karma?: KarmaConfigResult;
  readonly testsuite?: TestSuiteHtmlResult;
  readonly fallback: TestLayoutFallback;
}

export const FALLBACK_LAYOUT: TestLayoutFallback = Object.freeze({
  qunit: 'webapp/test/unit',
  opa5: 'webapp/test/integration',
});

export const KARMA_CONFIG_CANDIDATES: readonly string[] = Object.freeze([
  'karma.conf.js',
  'karma.conf.ts',
  'karma.conf.cjs',
  'karma.conf.mjs',
]);

const KARMA_FILES_OPEN = /files\s*:\s*\[/;
const QUOTED_LITERAL = /['"`]([^'"`\n]+)['"`]/g;
const HTML_ANCHOR_HREF = /<a\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/gi;

export function parseKarmaConfig(projectRoot: string): KarmaConfigResult | undefined {
  for (const candidate of KARMA_CONFIG_CANDIDATES) {
    const p = join(projectRoot, candidate);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    return { path: p, testFileGlobs: extractKarmaGlobs(content) };
  }
  return undefined;
}

function extractKarmaGlobs(content: string): readonly string[] {
  // F4: comment-mask then balance-scan the `files:` array (reusing the
  // registration fix's primitive) so an inline comment `]`, an object-form
  // entry, or a char-class glob no longer truncates the capture at the first
  // inner `]` — which would drop later globs and degrade `resolveQUnitRoot`
  // to the SPEC §2.7 fallback.
  const masked = stripJsComments(content);
  const open = KARMA_FILES_OPEN.exec(masked);
  if (open === null) return [];
  const openIdx = open.index + open[0].length - 1; // the `[`
  const closeIdx = findMatchingDelimiter(masked, openIdx, '[', ']');
  if (closeIdx === null) return [];
  const inner = masked.slice(openIdx + 1, closeIdx);
  const globs: string[] = [];
  for (const m of inner.matchAll(QUOTED_LITERAL)) {
    const captured = m[1];
    if (captured !== undefined && captured.length > 0) globs.push(captured);
  }
  return globs;
}

export function parseTestSuiteHtml(projectRoot: string): TestSuiteHtmlResult | undefined {
  const p = join(projectRoot, 'webapp', 'test', 'testsuite.qunit.html');
  if (!existsSync(p)) return undefined;
  const content = readFileSync(p, 'utf8');
  const entries: string[] = [];
  for (const m of content.matchAll(HTML_ANCHOR_HREF)) {
    const href = m[1];
    if (href !== undefined && href.length > 0) entries.push(href);
  }
  return { path: p, entries };
}

/**
 * Resolve the project's QUnit unit-test root from an inferred layout. The
 * orchestrator passes this into `missing-test-coverage` so derived expected-
 * test paths match the project's real karma config rather than the SPEC §2.7
 * fallback. Heuristic: pick the first karma `files:` glob containing a unit-
 * style suffix and slice off the wildcard tail. Fall back to
 * `FALLBACK_LAYOUT.qunit` when nothing matches.
 */
export function resolveQUnitRoot(layout: TestLayout): string {
  const globs = layout.karma?.testFileGlobs ?? [];
  for (const g of globs) {
    // V1.9 GA1-08 — a TS project's karma `files:` glob points at `.qunit.ts`
    // tests; accept that suffix too so the unit-test root resolves from the
    // config instead of silently falling back. The `.qunit.js` (JS) path is
    // unchanged.
    if (!g.includes('.qunit.js') && !g.includes('.qunit.ts')) continue;
    const wildcardIx = g.search(/\/\*\*|\*/);
    if (wildcardIx <= 0) continue;
    let root = g.slice(0, wildcardIx);
    while (root.endsWith('/')) root = root.slice(0, -1);
    if (root.length > 0) return root;
  }
  return layout.fallback.qunit;
}

/**
 * V1.4-4 — implements the V1.4-3 stub. Parse karma.conf.js's
 * `client: { libs: [...] }` override array (the karma-ui5 setting
 * that REPLACES the manifest-driven preload set when present).
 * Tolerant-regex sibling of the `files:` glob extraction (`extractKarmaGlobs`).
 *
 * Comment-stripping precedes the match so a `// client: { libs:
 * ['sap.m'] }` line never produces a false positive. The
 * comment-stripper preserves quoted strings and the original byte
 * offsets so subsequent quote extraction reads the same content the
 * developer wrote.
 *
 * COR-10: the `client` object body is brace-balanced and string-aware rather
 * than a flat `[^{}]*` scan, so a legal sibling object *before* `libs`
 * (e.g. `client: { nested: { prop: 1 }, libs: [...] }`) no longer hides it.
 * Only a TOP-LEVEL `libs` key inside `client` is read; a `libs` nested in a
 * sibling object is skipped — matching the `parseKarmaUi5Url` treatment.
 */
const KARMA_CLIENT_BLOCK_OPEN = /client\s*:\s*\{/;
const KARMA_CLIENT_LIBS_KEY = /^libs\s*:\s*\[/;
const KARMA_CLIENT_QUOTED_LITERAL = /"([^"\\\n]*)"|'([^'\\\n]*)'/g;

export function parseKarmaClientLibs(karmaConfigContent: string): readonly string[] {
  const stripped = stripJsComments(karmaConfigContent);
  const open = KARMA_CLIENT_BLOCK_OPEN.exec(stripped);
  if (open === null) return [];
  let i = open.index + open[0].length; // first char past `client: {`
  let depth = 0;
  let quote: string | null = null;
  while (i < stripped.length) {
    const ch = stripped.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return []; // end of the client block, no top-level libs
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === 'l' && !/[A-Za-z0-9_$.]/.test(stripped.charAt(i - 1))) {
      const key = KARMA_CLIENT_LIBS_KEY.exec(stripped.slice(i));
      if (key !== null) {
        const arrayOpenIdx = i + key[0].length - 1; // the `[`
        const closeIdx = findMatchingDelimiter(stripped, arrayOpenIdx, '[', ']');
        if (closeIdx === null) return [];
        return extractKarmaClientLibLiterals(stripped.slice(arrayOpenIdx + 1, closeIdx));
      }
    }
    i++;
  }
  return [];
}

function extractKarmaClientLibLiterals(body: string): readonly string[] {
  const result: string[] = [];
  for (const m of body.matchAll(KARMA_CLIENT_QUOTED_LITERAL)) {
    const captured = m[1] ?? m[2];
    if (captured !== undefined && captured.length > 0) result.push(captured);
  }
  return result;
}

/**
 * V1.4-10 — parse the karma-ui5 `ui5: { url: "<cdn>" }` value from a
 * karma config. Returns the URL string, or `null` when no `ui5.url` is
 * present (karma-ui5 then resolves the runtime from local resources).
 * Used by the CDN-availability probe so the unpreloaded-libs check can
 * tell a manifest-fixable gap (the lib IS served by the configured CDN)
 * apart from a stub-only gap (the lib 404s on that CDN — declaring it in
 * the manifest would not help). Comment-stripped first so a commented-out
 * `ui5: { url: ... }` never matches. Tolerant-by-design: returns `null`
 * on any shape it cannot read, mirroring `parseKarmaClientLibs`.
 *
 * A3 (V1.5): the `ui5` object body is brace-balanced and string-aware rather
 * than a flat `[^{}]*` scan, so a legal `paths`/`config` sibling object
 * *before* `url` (e.g. `ui5: { paths: { ... }, url: '...' }`) no longer hides
 * it — a `null` here wrongly defaulted every gap to `cdnServed:true` and
 * routed a CDN-absent lib to the manifest fix (karma hang). Only a *top-level*
 * `url` key is read; a `url` nested inside a sibling object is skipped.
 */
const KARMA_UI5_BLOCK_OPEN = /ui5\s*:\s*\{/;
const UI5_URL_KEY = /^url\s*:\s*["']([^"'\n]+)["']/;

export function parseKarmaUi5Url(karmaConfigContent: string): string | null {
  const stripped = stripJsComments(karmaConfigContent);
  const open = KARMA_UI5_BLOCK_OPEN.exec(stripped);
  if (open === null) return null;
  let i = open.index + open[0].length; // first char past the `ui5: {`
  let depth = 0;
  let quote: string | null = null;
  while (i < stripped.length) {
    const ch = stripped.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return null; // end of the ui5 block, no top-level url
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === 'u' && !/[A-Za-z0-9_$.]/.test(stripped.charAt(i - 1))) {
      const url = UI5_URL_KEY.exec(stripped.slice(i))?.[1];
      if (url !== undefined && url.length > 0) return url;
    }
    i++;
  }
  return null;
}

export function detectTestLayout(projectRoot: string): TestLayout {
  const karma = parseKarmaConfig(projectRoot);
  const testsuite = parseTestSuiteHtml(projectRoot);
  const inferredFrom: LayoutInference =
    karma !== undefined || testsuite !== undefined ? 'config' : 'fallback';
  return {
    inferredFrom,
    fallback: FALLBACK_LAYOUT,
    ...(karma !== undefined ? { karma } : {}),
    ...(testsuite !== undefined ? { testsuite } : {}),
  };
}
