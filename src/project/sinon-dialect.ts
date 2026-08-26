/**
 * V1.3.2-4 — detect which sinon dialect a SAPUI5 project uses, so the QUnit
 * test generator can steer the LLM away from APIs that do not exist in the
 * runtime's bundled sinon.
 *
 * The cap_try real-project run surfaced the load-bearing failure: the project
 * has no `sinon` in `package.json` and no bundled-sinon reference in
 * `testsuite.qunit.html`, but every existing `.qunit.js` test loads
 * `sap/ui/thirdparty/sinon` via `sap.ui.define([...])`. The runtime is the
 * karma-ui5 default — sinon 1.17 — and the LLM-generated tests used sinon
 * 2.x APIs (`.callsFake`, `.resolves`, `.rejects`, `sinon.createSandbox()`),
 * crashing with `TypeError: ...callsFake is not a function`. See
 * V1.3.2-DIAGNOSIS.md §"Bug B" for the full root-cause walk.
 *
 * Behaviour boundaries (also recorded in the V1.3.2-4 commit body):
 *
 * 1. **AC1 four-signal precedence (modern > .qunit.js content > HTML > karma-
 *    ui5 default > unknown).** `'modern'` wins over any `'sap-bundled'`
 *    signal because an npm-installed sinon shadows the karma-ui5 bundled
 *    one at runtime. The `.qunit.js` content scan beats the HTML scan beats
 *    the karma-ui5 default because direct evidence (an existing test file
 *    that loads `sap/ui/thirdparty/sinon`) is stronger than indirect
 *    evidence (the runtime default would be bundled). The `.qunit.js` scan
 *    is the load-bearing signal — it is the only one that fires for the
 *    cap_try project shape (no sinon dep, no HTML reference, but
 *    `sap.ui.define(["sap/ui/thirdparty/sinon", …])` in the unit tests).
 *
 * 2. **`'sap-bundled'` is the karma-ui5 default, not an exotic
 *    classification.** A project with karma-ui5 in devDependencies (or a
 *    `karma.conf.{js,ts}` file) and no `sinon` dependency lands on
 *    `'sap-bundled'`. `'unknown'` is reserved for projects with no karma-ui5
 *    evidence at all and no sinon dep — rare, not the default.
 *
 * 3. **Case sensitivity.** UI5 module IDs are case-sensitive at runtime, so
 *    the `.qunit.js` and HTML scans use literal substring matches against
 *    `"sap/ui/thirdparty/sinon"` — no case-insensitive variant.
 *
 * 4. **Best-effort file reads.** Missing files, EACCES, malformed JSON,
 *    permission errors — every read is wrapped so the function never
 *    throws. A missing `projectRoot` resolves to `'unknown'` without
 *    raising. This is pinned by the witness at
 *    [test/unit/sinon-dialect.test.ts](../../test/unit/sinon-dialect.test.ts)
 *    in the "missing project root does not throw" case.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveQUnitRoot, type TestLayout } from './test-layout.js';

export type SinonDialect = 'sap-bundled' | 'modern' | 'unknown';

interface PackageJsonShape {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const BUNDLED_SINON_MODULE_ID = 'sap/ui/thirdparty/sinon';

/**
 * Best-effort parse of `<projectRoot>/package.json`. Returns `undefined` on
 * missing file, read error, or malformed JSON — the caller treats any
 * `undefined` as "the package.json signals nothing" and falls through.
 */
function readPackageJson(projectRoot: string): PackageJsonShape | undefined {
  const p = join(projectRoot, 'package.json');
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return parsed as PackageJsonShape;
  } catch {
    return undefined;
  }
}

function hasDependency(pkg: PackageJsonShape | undefined, name: string): boolean {
  if (pkg === undefined) return false;
  if (pkg.dependencies?.[name] !== undefined) return true;
  if (pkg.devDependencies?.[name] !== undefined) return true;
  return false;
}

/**
 * Walk the QUnit test root one level deep — cap_try-shape tests live at
 * `<qunit-root>/controller/<Name>.controller.qunit.js`. Best-effort: missing
 * directories return `[]`, never throw.
 */
function listQunitFiles(qunitRoot: string): readonly string[] {
  const out: string[] = [];
  const visit = (dir: string, depthLeft: number): void => {
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= 5) return;
      const abs = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depthLeft > 0) visit(abs, depthLeft - 1);
        continue;
      }
      // V1.9 GA1-07 — a TS project's tests are `.qunit.ts` / `.test.ts`; the
      // bundled-sinon substring scan that consumes these is extension-blind, so
      // widening the filename filter re-arms Signal-2 for TS. `.qunit.js` (the
      // JS path) is unchanged.
      if (
        name.endsWith('.qunit.js') ||
        name.endsWith('.qunit.ts') ||
        name.endsWith('.test.ts')
      ) {
        out.push(abs);
      }
    }
  };
  visit(qunitRoot, 1);
  return out;
}

function anyQunitFileLoadsBundledSinon(qunitFiles: readonly string[]): boolean {
  for (const abs of qunitFiles) {
    try {
      const content = readFileSync(abs, 'utf8');
      if (content.includes(BUNDLED_SINON_MODULE_ID)) return true;
    } catch {
      // best-effort; next file
    }
  }
  return false;
}

function testsuiteHtmlMentionsBundledSinon(projectRoot: string): boolean {
  const p = join(projectRoot, 'webapp', 'test', 'testsuite.qunit.html');
  try {
    const content = readFileSync(p, 'utf8');
    return content.includes(BUNDLED_SINON_MODULE_ID);
  } catch {
    return false;
  }
}

function projectUsesKarmaUi5(projectRoot: string, pkg: PackageJsonShape | undefined): boolean {
  if (hasDependency(pkg, 'karma-ui5')) return true;
  if (existsSync(join(projectRoot, 'karma.conf.js'))) return true;
  if (existsSync(join(projectRoot, 'karma.conf.ts'))) return true;
  if (existsSync(join(projectRoot, 'karma.conf.cjs'))) return true;
  if (existsSync(join(projectRoot, 'karma.conf.mjs'))) return true;
  return false;
}

export function detectSinonDialect(
  projectRoot: string,
  layout?: TestLayout,
): SinonDialect {
  const pkg = readPackageJson(projectRoot);

  // Signal 1: modern wins (npm-installed sinon shadows the karma-ui5-bundled
  // one at runtime — see boundary 1).
  if (hasDependency(pkg, 'sinon')) return 'modern';

  // Signal 2: an existing .qunit.js file loads the bundled sinon module id.
  // This is the cap_try-shape signal: direct evidence beats indirect.
  const qunitRoot = layout !== undefined
    ? join(projectRoot, resolveQUnitRoot(layout))
    : join(projectRoot, 'webapp', 'test', 'unit');
  const qunitFiles = listQunitFiles(qunitRoot);
  if (anyQunitFileLoadsBundledSinon(qunitFiles)) return 'sap-bundled';

  // Signal 3: testsuite.qunit.html references the bundled sinon module id.
  if (testsuiteHtmlMentionsBundledSinon(projectRoot)) return 'sap-bundled';

  // Signal 4: karma-ui5 default — karma-ui5 in devDependencies or any
  // karma.conf.{js,ts,cjs,mjs} on disk.
  if (projectUsesKarmaUi5(projectRoot, pkg)) return 'sap-bundled';

  return 'unknown';
}

/**
 * Clause appended to QUnit prompts when {@link detectSinonDialect} returns
 * `'sap-bundled'`. Steers the LLM away from sinon 2.x APIs that do not exist
 * in the karma-ui5-bundled sinon 1.17. The load-bearing tokens (the module
 * id, the version string, the 2.x APIs we forbid, the 1.x APIs we mandate)
 * are pinned by
 * [test/unit/sinon-dialect.test.ts](../../test/unit/sinon-dialect.test.ts)
 * and by the Bug-B integration witnesses in
 * [test/integration/generate.test.ts](../../test/integration/generate.test.ts).
 *
 * Note on the USE list: `.returnsArg(n)` and `.withArgs(x).returns(y)` are
 * supported in sinon 1.x (the V1.3.2-PLAN draft mistakenly listed them as
 * 2.x-only). `sinon.sandbox.create()` (1.x) and `sinon.createSandbox()` (2.x)
 * are the canonical sandbox-creation divergence and both appear here so the
 * LLM cannot conflate them.
 */
export const SAP_BUNDLED_SINON_CLAUSE = [
  '',
  'Sinon constraints (this project uses sap/ui/thirdparty/sinon,',
  'which is sinon 1.17):',
  '  - Depend on "sap/ui/thirdparty/sinon" in the sap.ui.define array',
  '    and use the value it returns. Do NOT import',
  '    "sap/ui/thirdparty/sinon-qunit": the bundled sinon module does',
  '    NOT register a global `sinon`, so sinon-qunit throws',
  '    "sinon is not defined" at load. Integrate with QUnit via plain',
  '    QUnit.test assertions plus a sinon sandbox restored in',
  '    afterEach — not the sinon-qunit adapter.',
  '  - AVOID: .callsFake(...), .resolves(...), .rejects(...), and',
  '    sinon.createSandbox() — these were added in sinon 2.0 and do',
  '    NOT exist in 1.17.',
  '  - USE: sinon.sandbox.create() to create a sandbox (NOT',
  '    sinon.createSandbox()).',
  '  - USE: .returns(value), .returnsArg(n), .yields(...),',
  '    .callsArgWith(n, ...), .withArgs(x).returns(y) — these all',
  '    work in 1.17.',
  '  - For async stubbing, return a fulfilled Promise from',
  '    .returns(...). Example:',
  "      sinon.stub(obj, 'method').returns(Promise.resolve(value));",
  '  - Sandbox pattern:',
  '      const sandbox = sinon.sandbox.create();',
  "      sandbox.stub(obj, 'method').returns(value);",
  '      // ... test body ...',
  '      sandbox.restore();',
].join('\n');

/**
 * V1.9.3 (D4) — the **TypeScript** twin of {@link SAP_BUNDLED_SINON_CLAUSE}.
 *
 * The JS clause above is written entirely for AMD: it tells the LLM to *"Depend
 * on `sap/ui/thirdparty/sinon` in the `sap.ui.define` array"*. Appending it to a
 * TypeScript generation prompt — which forbids `sap.ui.define` and mandates a
 * native ES module — is a self-contradiction (V1.9.3 D4): the dominant prompt
 * says "ES module, no AMD" while the spliced clause demands the AMD array form.
 * The two TS prompt builders ({@link buildInitialQunitPromptTs} /
 * {@link buildQunitRefinementPromptTs} in
 * [src/generation/qunit.ts](../generation/qunit.ts)) use THIS clause instead
 * when `detectSinonDialect` returns `'sap-bundled'`.
 *
 * It keeps the **load-bearing, language-neutral** part of the JS clause — the
 * sinon 1.17-vs-2.x API guidance (the 2.x APIs that burned cap_try are absent in
 * the karma-ui5-bundled 1.17; the 1.x APIs to use instead) — and the sinon-qunit
 * warning, but expresses the module wiring as an **ES-module `import`** rather
 * than the AMD dependency array. The JS clause is untouched (the JS builders
 * still splice {@link SAP_BUNDLED_SINON_CLAUSE} byte-for-byte). Both clauses'
 * tokens are pinned by
 * [test/unit/sinon-dialect.test.ts](../../test/unit/sinon-dialect.test.ts), and
 * the TS-vs-JS prompt-splicing contract by
 * [test/unit/qunit-prompt-context.test.ts](../../test/unit/qunit-prompt-context.test.ts).
 */
export const SAP_BUNDLED_SINON_CLAUSE_TS = [
  '',
  'Sinon constraints (this project uses sap/ui/thirdparty/sinon, sinon 1.17):',
  '  - Import it as an ES module: `import sinon from "sap/ui/thirdparty/sinon";`',
  '    (do NOT use sap.ui.define, and do NOT import',
  '    "sap/ui/thirdparty/sinon-qunit": the bundled sinon registers no global',
  '    `sinon`, so sinon-qunit throws "sinon is not defined" at load).',
  '  - AVOID: .callsFake(...), .resolves(...), .rejects(...), and',
  '    sinon.createSandbox() — these were added in sinon 2.0 and do NOT exist',
  '    in 1.17.',
  '  - USE: sinon.sandbox.create() to create a sandbox (NOT sinon.createSandbox()),',
  '    and .returns(value), .returnsArg(n), .yields(...), .callsArgWith(n, ...),',
  '    .withArgs(x).returns(y) — these all work in 1.17.',
  '  - For async stubbing, return a fulfilled Promise from .returns(...). Example:',
  "      sinon.stub(obj, 'method').returns(Promise.resolve(value));",
].join('\n');
