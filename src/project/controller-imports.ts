/**
 * V1.4-4 — implements the V1.4-3 stub. Parses a SAPUI5 controller's
 * `sap.ui.define([...], function(){})` import array.
 *
 * Implementation is a single-pass state-machine scanner over the
 * controller content. The state-machine approach (rather than the
 * regex-first sketch in the V1.4-3 stub JSDoc) handles AH1's
 * load-bearing case in one go: a module-ID literal containing a
 * closing bracket (e.g., `"path/to/[weird]"`) does NOT prematurely
 * terminate the array body because the scanner tracks the
 * `in-string` state and ignores brackets inside string literals.
 *
 * Behaviour-boundary notes (V1.4-4, AH1):
 *   - **The `sap.ui.define([` head is located over comment-masked
 *     content (V1.4-11).** A commented-out or JSDoc-`@example`
 *     `sap.ui.define([...])` above the live one must NOT hijack the
 *     parse — pre-V1.4-11 the head regex ran over raw source and
 *     locked onto the first textual match, returning the commented
 *     imports and dropping the real ones (worst case: a fictional lib
 *     written to manifest.json under --auto-apply-baseline-fixes).
 *     `stripJsComments` is length-preserving, so the matched index
 *     maps cleanly back onto the original content the scanner walks.
 *   - **String-literal scope is handled by the scanner, not a separate
 *     post-capture quote-extraction phase.** The scanner reads quoted
 *     module-IDs inline as it walks the array body; brackets inside
 *     a string literal don't decrement the bracket-depth counter; a
 *     `/` immediately followed by `/` or `*` enters a comment-skip
 *     state so quoted text inside comments (`// "evil"`) never leaks
 *     into the result. This layering is load-bearing — a future
 *     refactor must NOT silently collapse the state-machine into a
 *     regex pair, or AH1 + the `comments inside the import array`
 *     witness will regress together.
 *
 *   - **Conservative-by-design.** When the scanner encounters
 *     unterminated input (unbalanced brackets, unterminated string),
 *     it returns whatever module-IDs it had captured so far rather
 *     than throwing. The V1.4-4 `buildProjectGraph` builder treats
 *     missing-input cases (no `sap.ui.define`, factory-only define,
 *     plain helper module) as zero imports for the gap computation —
 *     no `unpreloaded-libs` finding fires falsely.
 *
 *   - **First-occurrence deduplication.** The scanner deduplicates
 *     while preserving first-occurrence order so the
 *     `unpreloadedLibs[*].importedBy` array reads naturally for
 *     human-facing messages.
 *
 *   - **String escapes.** Backslash escapes (`\\`, `\'`, `\"`, `\n`,
 *     `\t`, `\r`) are decoded; unrecognised escapes pass through the
 *     literal character. UI5 module IDs in practice contain none of
 *     these, but the decoding keeps the scanner robust against
 *     hand-written tests with edge-case strings.
 */

import { stripJsComments } from '../util/strip-js-comments.js';

const SAP_UI_DEFINE_HEAD = /sap\.ui\.define\s*\(\s*\[/;

export function parseControllerImports(content: string): readonly string[] {
  // Locate the head over comment-masked content (length-preserving) so a
  // commented-out / JSDoc-@example `sap.ui.define([...])` cannot hijack the
  // parse (V1.4-11). COR-5: ALSO mask regex-literal bodies so a
  // `/sap.ui.define(['sap/m/Button'])/` regex cannot be mistaken for the live
  // head and fabricate phantom imports (→ a false unpreloaded-lib gap → a bad
  // `--auto-apply-baseline-fixes` manifest write). The scanner below then walks
  // the ORIGINAL content from the matched index — its own comment-skip handling
  // covers comments that sit INSIDE the live array body.
  const startMatch = SAP_UI_DEFINE_HEAD.exec(
    stripJsComments(content, { maskRegexLiterals: true }),
  );
  if (startMatch === null || startMatch.index === undefined) return [];
  let i = startMatch.index + startMatch[0].length;
  let bracketDepth = 1;
  let inLineComment = false;
  let inBlockComment = false;
  const imports: string[] = [];
  while (i < content.length) {
    const ch = content.charAt(i);
    const next = content.charAt(i + 1);
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const read = readStringLiteral(content, i, ch);
      if (read === null) return dedupePreserveOrder(imports);
      imports.push(read.value);
      i = read.endIndex;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      i++;
      continue;
    }
    if (ch === ']') {
      bracketDepth--;
      if (bracketDepth === 0) return dedupePreserveOrder(imports);
      i++;
      continue;
    }
    i++;
  }
  return dedupePreserveOrder(imports);
}

/**
 * V1.9 GA1-03 — hand-rolled ES-module import parser for TypeScript-SAPUI5
 * controllers. A TS controller has **no `sap.ui.define([...])` head**
 * ({@link parseControllerImports} returns `[]` for it — the silent zero-result
 * that makes the unpreloaded-libs spine inert for TS, diagnosis §2.2). This
 * scanner recognizes the four static import forms a real TS controller uses:
 *   - `import Default from 'mod'`
 *   - `import { a, b as c } from 'mod'`
 *   - `import * as ns from 'mod'`
 *   - `import 'mod'`  (side-effect)
 * plus their combinations (`import Default, { a } from 'mod'`). It emits the
 * SAME imported-module-id shape `parseControllerImports` produces (bare UI5
 * module IDs, first-occurrence-deduplicated) so `libNamespaces` /
 * `buildProjectGraph` / `baseline-unpreloaded-libs` consume it unchanged — the
 * dependency-graph routes TS controllers here and JS controllers to the
 * `sap.ui.define` parser above (the JS path stays byte-identical).
 *
 * This is a STATEMENT scanner, not a type parser — there is **no `typescript`
 * dependency**. It reuses the same comment/string state-machine the JS parser
 * does via `stripJsComments` (comments masked length-preserving so a
 * commented-out `import` never parses; string literals preserved so the
 * module-id specifiers survive) and the same `readStringLiteral` /
 * `dedupePreserveOrder` primitives.
 *
 * Behaviour-boundary notes (V1.9 GA1-03):
 *   - **Relative specifiers (`./`, `../`) are excluded.** A relative ES import
 *     is intra-project (resolved against the importing file's own directory),
 *     never a bare UI5 *library* module — mirroring the dependency-graph's
 *     project-local namespace filtering. Counting `../Component` would derive a
 *     bogus `..` "library" and fabricate a gap.
 *   - **Type-only imports (`import type …`) are excluded.** They are erased at
 *     transpile time and trigger no runtime module load, so counting them would
 *     fabricate a gap (the offline phantom-write class the spine exists to
 *     prevent). The `type`-as-binding-NAME forms (`import type from 'm'`,
 *     `import type, { x } from 'm'`) are NOT type-only and ARE counted; an
 *     `import type = require(...)` import-equals is not a module import we model.
 *   - **Dynamic `import(...)` and `import.meta` are not static imports** and are
 *     skipped — the former is a lazy runtime call, not a preload dependency.
 *   - **Conservative-by-design.** A malformed / unterminated import contributes
 *     nothing rather than throwing — the same posture as the JS parser.
 */
export function parseEsModuleImports(content: string): readonly string[] {
  // Mask comments first (length-preserving) so a commented-out `import` never
  // parses; string literals (the module specifiers) are preserved, so the scan
  // below reads them straight out of the masked text.
  const masked = stripJsComments(content);
  const imports: string[] = [];
  let i = 0;
  let quote: '"' | "'" | '`' | null = null;
  while (i < masked.length) {
    const ch = masked.charAt(i);
    if (quote !== null) {
      // Skip string interiors so an `import` appearing inside a string literal
      // (e.g. `const s = "import x from 'y'"`) is never mistaken for a statement.
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
    if (ch === 'i' && isKeywordAt(masked, i, 'import')) {
      const parsed = parseImportStatement(masked, i);
      if (parsed !== null) {
        if (parsed.moduleId !== null && !isRelativeSpecifier(parsed.moduleId)) {
          imports.push(parsed.moduleId);
        }
        i = parsed.endIndex;
        continue;
      }
      i += IMPORT_KEYWORD.length;
      continue;
    }
    i++;
  }
  return dedupePreserveOrder(imports);
}

const IMPORT_KEYWORD = 'import';
const IDENT_CHAR = /[A-Za-z0-9_$]/u;

interface ParsedImportStatement {
  /** The imported module id, or `null` when the statement is recognized but is
   * not a counted runtime import (a type-only import). */
  readonly moduleId: string | null;
  /** Index just past the statement's module specifier (where scanning resumes). */
  readonly endIndex: number;
}

/**
 * Parse one `import` statement starting at `start` (the `i` of `import`, already
 * confirmed a keyword). Returns `null` for constructs that are not a static
 * module-importing statement (dynamic `import(`, `import.meta`, `import x =
 * require(...)`, or a malformed head) — the caller then advances past the
 * keyword only.
 */
function parseImportStatement(s: string, start: number): ParsedImportStatement | null {
  let i = skipWhitespace(s, start + IMPORT_KEYWORD.length);
  const c = s.charAt(i);
  // Dynamic `import(` or `import.meta` — not a static import statement.
  if (c === '(' || c === '.') return null;
  // Side-effect import: `import 'mod'`.
  if (c === '"' || c === "'") {
    const read = readStringLiteral(s, i, c);
    if (read === null) return null;
    return { moduleId: read.value, endIndex: read.endIndex };
  }
  // A clause import (default / namespace / named), optionally TS `type`-only.
  let typeOnly = false;
  if (isKeywordAt(s, i, 'type')) {
    const afterType = skipWhitespace(s, i + 'type'.length);
    const tc = s.charAt(afterType);
    // `import type = require(...)` — import-equals named `type` (not modelled).
    if (tc === '=') return null;
    // `import type from 'm'` / `import type, {…} from 'm'` → `type` is the
    // default binding NAME, not a modifier. Otherwise (ident / `{` / `*`) it is
    // the type-only modifier and the whole import is erased at transpile time.
    if (!isKeywordAt(s, afterType, 'from') && tc !== ',') {
      typeOnly = true;
      i = afterType;
    }
  }
  const fromIdx = findClauseFrom(s, i);
  if (fromIdx === null) return null;
  const j = skipWhitespace(s, fromIdx + 'from'.length);
  const q = s.charAt(j);
  if (q !== '"' && q !== "'") return null;
  const read = readStringLiteral(s, j, q);
  if (read === null) return null;
  return { moduleId: typeOnly ? null : read.value, endIndex: read.endIndex };
}

/**
 * Locate the `from` keyword that terminates an import clause, starting at the
 * clause's first character. Tracks `{}`/`[]`/`()` nesting and string literals so
 * a `from` used as an imported *name* (`import { from as x } from 'm'`) does not
 * end the clause; only a top-level (depth-0) `from` does. Returns `null` for a
 * malformed clause (a depth-0 `;` before any `from`, or none at all).
 */
function findClauseFrom(s: string, start: number): number | null {
  let i = start;
  let depth = 0;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s.charAt(i);
    if (quote !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === ';') return null;
      if (c === 'f' && isKeywordAt(s, i, 'from')) return i;
    }
    i++;
  }
  return null;
}

function skipWhitespace(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const c = s.charAt(j);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') j++;
    else break;
  }
  return j;
}

/** True when `kw` sits at `i` as a whole word (no identifier char on either side). */
function isKeywordAt(s: string, i: number, kw: string): boolean {
  if (!s.startsWith(kw, i)) return false;
  const before = i > 0 ? s.charAt(i - 1) : '';
  const after = s.charAt(i + kw.length);
  return !IDENT_CHAR.test(before) && !IDENT_CHAR.test(after);
}

/** A bare UI5 module id never starts with `.`; a leading `.` marks a relative,
 * intra-project specifier (`./x`, `../x`) which is excluded from the lib set. */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}

interface StringReadResult {
  readonly value: string;
  readonly endIndex: number;
}

function readStringLiteral(
  content: string,
  start: number,
  quote: '"' | "'",
): StringReadResult | null {
  let i = start + 1;
  let value = '';
  while (i < content.length) {
    const ch = content.charAt(i);
    if (ch === '\\') {
      const escaped = content.charAt(i + 1);
      switch (escaped) {
        case '\\':
          value += '\\';
          break;
        case "'":
          value += "'";
          break;
        case '"':
          value += '"';
          break;
        case 'n':
          value += '\n';
          break;
        case 't':
          value += '\t';
          break;
        case 'r':
          value += '\r';
          break;
        default:
          value += escaped;
          break;
      }
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value, endIndex: i + 1 };
    }
    value += ch;
    i++;
  }
  return null;
}

function dedupePreserveOrder(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
