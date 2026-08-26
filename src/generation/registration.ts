/**
 * V1.3-4 — register generated QUnit tests with the project's test runner so
 * the karma verify step actually executes them (SPEC §1.2, §2.9).
 *
 * A karma-ui5 *html mode* project discovers tests through
 * `webapp/test/testsuite.qunit.html`'s `sap.ui.require([...])` module-id array
 * — not via `<a href>` links and not via a karma `files:` glob. A generated
 * test file that is not inserted into that array is orphaned: karma never
 * loads it, the verify step passes vacuously, and `generate` would report an
 * unexecuted test as "passed", defeating SPEC §1.2. This module closes that
 * gap by parsing and writing the discovery array.
 *
 * Parsing follows the tolerant-regex style of
 * [src/project/test-layout.ts](../project/test-layout.ts) — no HTML parser,
 * no new dependency: locate the array literal, collect its quoted entries,
 * mutate, and write the array back. `parseTestSuiteHtml` cannot be reused:
 * it collects only `<a href>` entries and returns nothing for this format.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertInsideProject } from '../util/containment.js';
import { KARMA_CONFIG_CANDIDATES } from '../project/test-layout.js';
import { stripJsComments } from '../util/strip-js-comments.js';
import { findMatchingDelimiter } from '../util/balance-scan.js';

/**
 * How the project's karma run discovers which test modules to execute.
 *
 *  - `testsuite-require` — `testsuite.qunit.html` carries a
 *    `sap.ui.require([...])` module-id array (karma-ui5 html-mode default);
 *    register by inserting the module id.
 *  - `karma-files-glob` — `karma.conf.*` has an explicit, wildcard-free
 *    `files:` array; register by inserting the test file path.
 *  - `glob-auto` — a karma `files:` entry globs a directory; the new file is
 *    picked up automatically, so registration is a no-op.
 *  - `unknown` — none of the above could be determined; refuse to register
 *    and let the caller warn (see V1.3-4 behavior-boundary note).
 */
export type DiscoveryMode =
  | 'testsuite-require'
  | 'karma-files-glob'
  | 'glob-auto'
  | 'unknown';

export interface RegistrationRequest {
  readonly projectRoot: string;
  readonly mode: DiscoveryMode;
  /** Dotted-namespace-to-slash module id; consumed by `testsuite-require`. */
  readonly moduleId: string;
  /** Project-root-relative POSIX test path; consumed by `karma-files-glob`. */
  readonly testFileRel: string;
}

// Array-opening matchers (stateless). We locate only the opening `[` and then
// balance-scan to the true close (F1) — comment-masking first and skipping
// string literals — so an inline comment `]`, an object-form `included:[...]`
// entry, or a char-class glob no longer truncates the capture the way a
// non-greedy `[\s\S]*?]` did.
const REQUIRE_ARRAY_OPEN = /sap\.ui\.require\s*\(\s*\[/;
const KARMA_FILES_ARRAY_OPEN = /files\s*:\s*\[/;
// First quoted literal in a segment — used to read a bare-string entry's value.
const QUOTED_LITERAL_SINGLE = /['"`]([^'"`\n]+)['"`]/;

// E1 — keep a quarantined test out of an auto-discovered karma suite.
const FAILING_EXCLUDE_GLOB = '**/test/_failing/**';
const KARMA_EXCLUDE_ARRAY_OPEN = /exclude\s*:\s*\[/;

const TESTSUITE_REL: readonly string[] = Object.freeze([
  'webapp',
  'test',
  'testsuite.qunit.html',
]);

/**
 * Classify how `projectRoot` discovers test modules.
 *
 * Precedence when signals overlap: `testsuite-require` wins over any karma
 * `files:` signal. Rationale — a `sap.ui.require([...])` testsuite.qunit.html
 * is the karma-ui5 *html mode* discovery mechanism, and html mode *forbids* a
 * karma `files:` array; so when both are present the testsuite array is the
 * one karma actually consults and a stray `files:` list is most likely
 * leftover. Inserting into the testsuite array is therefore the safe choice.
 */
export function detectDiscoveryMode(projectRoot: string): DiscoveryMode {
  const testsuite = readTestsuiteHtml(projectRoot);
  if (testsuite !== null && locateArray(testsuite, REQUIRE_ARRAY_OPEN) !== null) {
    return 'testsuite-require';
  }
  const karma = readKarmaConfig(projectRoot);
  if (karma !== null) {
    const loc = locateArray(karma.content, KARMA_FILES_ARRAY_OPEN);
    if (loc !== null) {
      const patterns = loc.entries
        .map(entryKey)
        .filter((p): p is string => p !== null);
      return patterns.some((p) => p.includes('*')) ? 'glob-auto' : 'karma-files-glob';
    }
  }
  return 'unknown';
}

/**
 * Compute the UI5 module id for a `webapp/`-relative `.js`/`.ts` source or test
 * file: the dotted `sap.app.id` namespace converted to slashes, joined to the
 * path relative to `webapp/` with the trailing `.js`/`.ts` removed. Two
 * production callers (which is why the param is generic `fileRel`, not
 * test-specific):
 *
 *   1. a generated test file's registration id, and
 *   2. (V1.6) the import id of the controller under test, pinned in the
 *      generation prompt so the LLM cannot drop the `.controller` segment of a
 *      `*.controller.js` file (which would import a non-existent `<Name>.js`).
 *      On a TS project (V1.9.2) this same id is the controller's ES default-
 *      import specifier (`import App from "<id>"`) — so the `.ts` extension MUST
 *      be stripped, exactly as `.js` is, or the import resolves to a missing
 *      `<Name>.controller.ts` module.
 *
 *   namespace `e2e.real.project`
 *   + `webapp/test/unit/controller/App.controller.qunit.js`
 *   → `e2e/real/project/test/unit/controller/App.controller.qunit`
 *
 *   namespace `cap_try` + `webapp/controller/App.controller.js`
 *   → `cap_try/controller/App.controller`
 *
 *   namespace `e2e.real.ts` + `webapp/controller/App.controller.ts`
 *   → `e2e/real/ts/controller/App.controller`
 */
export function computeModuleId(args: {
  readonly namespace: string;
  readonly fileRel: string;
}): string {
  const nsSlashes = args.namespace.replace(/\./gu, '/');
  let rel = args.fileRel.replace(/\\/gu, '/');
  if (rel.startsWith('webapp/')) rel = rel.slice('webapp/'.length);
  rel = rel.replace(/\.(?:js|ts)$/u, '');
  return `${nsSlashes}/${rel}`;
}

/**
 * Insert the generated test into the project's discovery array. Idempotent —
 * re-registering an already-present module/file is a no-op. `glob-auto` and
 * `unknown` modes are no-ops by design (see {@link DiscoveryMode}).
 */
export async function registerTest(req: RegistrationRequest): Promise<void> {
  await mutateRegistration(req, 'add');
}

/**
 * Remove the generated test from the project's discovery array — used when a
 * test is quarantined under `webapp/test/_failing/` so the broken file is not
 * pulled into the suite. Idempotent — unregistering an absent entry is a
 * no-op.
 */
export async function unregisterTest(req: RegistrationRequest): Promise<void> {
  await mutateRegistration(req, 'remove');
}

async function mutateRegistration(
  req: RegistrationRequest,
  op: 'add' | 'remove',
): Promise<void> {
  if (req.mode === 'glob-auto' || req.mode === 'unknown') {
    // E1: registration into an auto-discovered suite is a no-op, but on
    // *unregister* (a quarantine just moved the file under
    // webapp/test/_failing/) a broad `files:` glob would re-collect it on the
    // next karma run — poisoning the suite and generate's baseline karma probe.
    // Inject a karma `exclude` for the quarantine directory so the auto-glob
    // skips it.
    if (op === 'remove' && req.mode === 'glob-auto') {
      await ensureFailingExcluded(req.projectRoot);
    }
    return;
  }

  if (req.mode === 'testsuite-require') {
    const path = join(req.projectRoot, ...TESTSUITE_REL);
    if (!existsSync(path)) return;
    const updated = mutateArrayInFile(
      readFileSync(path, 'utf8'),
      REQUIRE_ARRAY_OPEN,
      op,
      req.moduleId,
    );
    if (updated !== null) {
      // v0.8.1 V1: the testsuite path is constant but `webapp/test/` (or the
      // file itself) can be a link out of the tree.
      await assertInsideProject(path, req.projectRoot);
      await writeFile(path, updated, 'utf8');
    }
    return;
  }

  // karma-files-glob
  const karma = readKarmaConfig(req.projectRoot);
  if (karma === null) return;
  const updated = mutateArrayInFile(
    karma.content,
    KARMA_FILES_ARRAY_OPEN,
    op,
    req.testFileRel,
  );
  if (updated !== null) {
    await assertInsideProject(karma.path, req.projectRoot);
    await writeFile(karma.path, updated, 'utf8');
  }
}

/**
 * E1 — inject a karma `exclude` for the quarantine directory so a `glob-auto`
 * project's broad `files:` glob does not re-collect a test that was quarantined
 * under `webapp/test/_failing/`. Idempotent: appends the glob to an existing
 * `exclude` array, or inserts a new `exclude` sibling immediately before
 * `files:` when none exists. No-op when there is no karma config or no `files:`
 * array.
 */
async function ensureFailingExcluded(projectRoot: string): Promise<void> {
  const karma = readKarmaConfig(projectRoot);
  if (karma === null) return;
  const masked = stripJsComments(karma.content);
  if (KARMA_EXCLUDE_ARRAY_OPEN.test(masked)) {
    const updated = mutateArrayInFile(
      karma.content,
      KARMA_EXCLUDE_ARRAY_OPEN,
      'add',
      FAILING_EXCLUDE_GLOB,
    );
    if (updated !== null) {
      await assertInsideProject(karma.path, projectRoot);
      await writeFile(karma.path, updated, 'utf8');
    }
    return;
  }
  const filesOpen = KARMA_FILES_ARRAY_OPEN.exec(masked);
  if (filesOpen === null) return;
  const indent = lineIndentAt(karma.content, filesOpen.index);
  const insertion = `exclude: ['${FAILING_EXCLUDE_GLOB}'],\n${indent}`;
  const updated =
    karma.content.slice(0, filesOpen.index) + insertion + karma.content.slice(filesOpen.index);
  await assertInsideProject(karma.path, projectRoot);
  await writeFile(karma.path, updated, 'utf8');
}

/**
 * Insert or remove `entry` in the array opened by `openRegex`. Returns the
 * rewritten file content, or `null` when nothing changed — the array was not
 * found / was unbalanced, or the entry was already present (`add`) / already
 * absent (`remove`). A `null` return is the caller's idempotent
 * skip-the-write signal.
 *
 * The array body is bounded by {@link locateArray} (comment-masked + balance-
 * scanned, F1) rather than a non-greedy regex, so an inline comment `]`, an
 * object-form entry, or a char-class glob inside the array no longer truncates
 * it and orphans the trailing entries on rewrite. The array is re-emitted with
 * one entry per line at a derived indentation so the result stays valid
 * JS/HTML. COR-4: an existing object-form entry `{ pattern, included, ... }` is
 * re-emitted from its original source (never flattened to a bare string), so a
 * `{ included: false }` helper is never silently re-defaulted to karma's
 * `included: true`. The newly-added entry is always a bare string (the test
 * file path / module id this tool registers carries no per-file flags).
 */
function mutateArrayInFile(
  content: string,
  openRegex: RegExp,
  op: 'add' | 'remove',
  entry: string,
): string | null {
  const loc = locateArray(content, openRegex);
  if (loc === null) return null;
  const present = loc.entries.some((e) => entryKey(e) === entry);

  let next: readonly ArrayEntry[];
  if (op === 'add') {
    if (present) return null;
    next = [...loc.entries, { kind: 'string', value: entry }];
  } else {
    if (!present) return null;
    next = loc.entries.filter((e) => entryKey(e) !== entry);
  }

  const baseIndent = lineIndentAt(content, loc.openIdx);
  const rebuilt = renderArray(next, baseIndent);
  return content.slice(0, loc.openIdx) + rebuilt + content.slice(loc.closeIdx + 1);
}

/**
 * One element of a discovery array.
 *
 *  - `string` — a bare quoted pattern (`'webapp/test/unit/X.qunit.js'`); the
 *    common testsuite-require / karma-files case. Re-emitted as a JSON string.
 *  - `object` — the karma `{ pattern, included, served, ... }` form (COR-4).
 *    Its `pattern` value is the add/remove match key, but the entry is
 *    re-emitted from its ORIGINAL source slice (`raw`) so flags like
 *    `included: false` survive the rewrite byte-faithfully — flattening it to a
 *    bare string silently re-defaults it to karma's `included: true` and loads
 *    a non-test helper into the browser.
 */
type ArrayEntry =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'object'; readonly pattern: string | null; readonly raw: string };

/** The add/remove match key for an entry (`null` for an object with no `pattern`). */
function entryKey(entry: ArrayEntry): string | null {
  return entry.kind === 'string' ? entry.value : entry.pattern;
}

interface ArrayLocation {
  /** Index of the opening `[` in `content`. */
  readonly openIdx: number;
  /** Index of the matching closing `]` in `content`. */
  readonly closeIdx: number;
  /** Parsed entries inside the array (comment text excluded). */
  readonly entries: ArrayEntry[];
}

/**
 * Locate the array opened by `openRegex` and return its `[`/`]` indices (into
 * the ORIGINAL `content`) plus its parsed entries. Comment-masks the content
 * first — so a commented-out array never matches and a `]` inside a comment
 * cannot end the scan — then balance-scans the brackets (skipping string
 * literals) for the true close. Entries are split over the masked interior so
 * a `,`/`}` inside a comment is not mistaken for structure, but each object
 * entry's `raw` text is sliced from the ORIGINAL content so its flags survive.
 * Returns `null` when the array is absent or unbalanced.
 */
function locateArray(content: string, openRegex: RegExp): ArrayLocation | null {
  const masked = stripJsComments(content);
  const open = openRegex.exec(masked);
  if (open === null) return null;
  const openIdx = open.index + open[0].length - 1; // the `[`
  const closeIdx = findMatchingDelimiter(masked, openIdx, '[', ']');
  if (closeIdx === null) return null;
  return { openIdx, closeIdx, entries: parseArrayEntries(content, masked, openIdx, closeIdx) };
}

const OBJECT_PATTERN_KEY = /pattern\s*:\s*['"`]([^'"`\n]+)['"`]/;

/**
 * Split the array body `(openIdx, closeIdx)` into its top-level entries.
 * Structure (commas, nesting, strings) is read from `masked` so a comment can
 * neither hide nor fake a separator; each entry's source range is then sliced
 * from the ORIGINAL `content` for byte-faithful object re-emission.
 */
function parseArrayEntries(
  content: string,
  masked: string,
  openIdx: number,
  closeIdx: number,
): ArrayEntry[] {
  const entries: ArrayEntry[] = [];
  let depth = 0;
  let quote: string | null = null;
  let segStart = openIdx + 1;
  const flush = (end: number): void => {
    const entry = classifyEntry(content, masked, segStart, end);
    if (entry !== null) entries.push(entry);
    segStart = end + 1;
  };
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const ch = masked.charAt(i);
    if (quote !== null) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) flush(i);
  }
  flush(closeIdx);
  return entries;
}

/** Classify one `[start, end)` array segment, or `null` if it is whitespace-only. */
function classifyEntry(
  content: string,
  masked: string,
  start: number,
  end: number,
): ArrayEntry | null {
  // Trim using the masked view (comments read as whitespace) so a leading
  // comment does not shift the classification, but slice `raw` from the
  // original so the object's real text (incl. any inline comment) is kept.
  let s = start;
  let e = end;
  while (s < e && /\s/u.test(masked.charAt(s))) s++;
  while (e > s && /\s/u.test(masked.charAt(e - 1))) e--;
  if (s >= e) return null;
  const head = masked.charAt(s);
  if (head === '{') {
    const raw = content.slice(s, e);
    const m = OBJECT_PATTERN_KEY.exec(masked.slice(s, e));
    return { kind: 'object', pattern: m?.[1] ?? null, raw };
  }
  const m = QUOTED_LITERAL_SINGLE.exec(masked.slice(s, e));
  const value = m?.[1];
  if (value === undefined || value.length === 0) return null;
  return { kind: 'string', value };
}

function renderArray(entries: readonly ArrayEntry[], baseIndent: string): string {
  if (entries.length === 0) return '[]';
  const entryIndent = `${baseIndent}  `;
  const body = entries
    .map((e) => `${entryIndent}${e.kind === 'string' ? JSON.stringify(e.value) : e.raw}`)
    .join(',\n');
  return `[\n${body}\n${baseIndent}]`;
}

/** Leading whitespace of the line containing `index`. */
function lineIndentAt(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const prefix = content.slice(lineStart, index);
  return /^[ \t]*/u.exec(prefix)?.[0] ?? '';
}

function readTestsuiteHtml(projectRoot: string): string | null {
  const p = join(projectRoot, ...TESTSUITE_REL);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function readKarmaConfig(
  projectRoot: string,
): { readonly path: string; readonly content: string } | null {
  for (const candidate of KARMA_CONFIG_CANDIDATES) {
    const p = join(projectRoot, candidate);
    if (existsSync(p)) return { path: p, content: readFileSync(p, 'utf8') };
  }
  return null;
}
