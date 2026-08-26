/**
 * SPEC §2.8 check #7: missing test for exported public method.
 *
 * For a given controller (or helper) JavaScript file, determine which
 * exported public methods lack a corresponding QUnit test. Multi-file by
 * nature (the fix needs a new test file plus possibly testsuite/karma
 * updates), so every finding here has `proposedFix: null` and a human-
 * readable `explanation` — auto-fixing belongs to the `generate` command,
 * not `validate`.
 *
 * The expected test path is derived from the SPEC §2.7 fallback layout
 * (`webapp/test/unit/<mirror>/<Name>.qunit.js`). If the orchestrator (Session
 * 8) detects a different layout, it can supply a richer prompt later; the
 * fallback is correct for the minimal-project fixture and the SPEC default.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { FALLBACK_LAYOUT, resolveQUnitRoot } from '../project/test-layout.js';
import type { ProjectLanguage } from '../project/detect.js';
import {
  parseControllerImports,
  parseEsModuleImports,
} from '../project/controller-imports.js';
import { computeModuleId } from '../generation/registration.js';
import { parseJsonWithBom } from '../util/json-read.js';
import type { Finding } from '../types.js';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings, sourceFence, tsSourceGuidance } from './_shared.js';

export function buildMissingCoveragePrompt(args: {
  readonly controllerRelPath: string;
  readonly controllerContent: string;
  readonly testRelPath: string;
  readonly testContent: string | null;
  readonly language?: ProjectLanguage;
}): string {
  const language = args.language ?? 'js';
  const fence = '```' + sourceFence(language);
  const testBlock =
    args.testContent === null
      ? [`No test file exists at ${args.testRelPath}.`]
      : [
          `Existing test file: ${args.testRelPath}`,
          fence,
          args.testContent,
          '```',
        ];
  return [
    'Static check: `missing-test-coverage`.',
    '',
    'Enumerate the public methods exported by this controller / helper and',
    'identify which are NOT covered by a QUnit test. A method is "public"',
    'when it is attached to the returned object literal in',
    '`sap.ui.define(..., function (...) { return X.extend("...", { ... }) })`',
    'or is an explicitly named property on a returned module. Lifecycle',
    'hooks (`onInit`, `onExit`, `onBeforeRendering`, `onAfterRendering`) are',
    '*public* and DO count toward coverage — flag them when the test suite',
    'asserts nothing on them. Ignore methods whose name begins with `_`.',
    '',
    'A method is covered when the test file contains a `QUnit.test(...)`',
    'whose body references the method name, OR a `QUnit.module(...)` whose',
    '`beforeEach` constructs the controller and exercises the method.',
    '',
    'Every finding here is multi-file (a new test must be created, possibly',
    'with testsuite / karma glob updates). Always return `proposedFix: null`',
    'and put the rationale + suggested test outline in `explanation`.',
    '',
    ...tsSourceGuidance(language),
    `Controller: ${args.controllerRelPath}`,
    fence,
    args.controllerContent,
    '```',
    '',
    ...testBlock,
    '',
    'Output: {"findings": [Finding, ...]}',
    'Each Finding has:',
    '  - "checkId": "missing-test-coverage"',
    `  - "file": "${args.controllerRelPath}"`,
    '  - "line": <line where the uncovered method is declared, if known>',
    '  - "message": "<method name> has no test"',
    '  - "proposedFix": null',
    '  - "explanation": "<which test is missing and a sketch of what it',
    '     should assert>"',
    '',
    'Return {"findings": []} if every public method is covered.',
  ].join('\n');
}

export const missingTestCoverageCheck: CheckModule = {
  id: 'missing-test-coverage',
  scope: 'controller-js',
  async run(target, ctx): Promise<CheckResult> {
    const controllerContent = await readFile(target, 'utf8');
    const controllerRel = toPosix(relative(ctx.projectRoot, target));
    const qunitRoot =
      ctx.testLayout !== undefined ? resolveQUnitRoot(ctx.testLayout) : FALLBACK_LAYOUT.qunit;
    const testRel = expectedTestPath(controllerRel, qunitRoot);
    const testAbs = join(ctx.projectRoot, testRel);
    const testContent = existsSync(testAbs) ? readFileSync(testAbs, 'utf8') : null;
    const prompt = buildMissingCoveragePrompt({
      controllerRelPath: controllerRel,
      controllerContent,
      testRelPath: testRel,
      testContent,
      language: ctx.projectLanguage ?? 'js',
    });
    const findings = await callLlmForFindings({
      checkId: 'missing-test-coverage',
      file: controllerRel,
      prompt,
      mode: 'manual-only',
      ctx,
    });
    return { findings };
  },
};

/**
 * Map a controller-or-helper path to its expected QUnit test path. Default is
 * the SPEC §2.7 fallback (`webapp/test/unit`); pass a non-default `qunitRoot`
 * to follow a karma config inferred via `resolveQUnitRoot`. The `.controller`
 * suffix is preserved; only the trailing extension is rewritten — `.js` →
 * `.qunit.js`, and (V1.9 GA1-06) a TS controller's `.ts` → `.qunit.ts`. Without
 * the `.ts` arm a TS controller path is left untouched (the `.js`-only regex is
 * a no-op on it), which derived a wrong test path and produced false
 * "missing test" findings.
 */
export function expectedTestPath(
  controllerRelPath: string,
  qunitRoot: string = FALLBACK_LAYOUT.qunit,
): string {
  const trimmed = controllerRelPath.startsWith('webapp/')
    ? controllerRelPath.slice('webapp/'.length)
    : controllerRelPath;
  const swapped = /\.ts$/u.test(trimmed)
    ? trimmed.replace(/\.ts$/u, '.qunit.ts')
    : trimmed.replace(/\.js$/u, '.qunit.js');
  return `${qunitRoot}/${swapped}`;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// V1.9.1 (Fix C / I4) — deterministic coverage triage

/**
 * V1.9.1 (Fix C / I4) — the result of {@link triageCoverageTargets}.
 */
export interface CoverageTriage {
  /**
   * Controller targets an in-scope test imports — these keep the per-method
   * `missing-test-coverage` LLM check (per-method coverage is a genuine
   * semantic question). When the triage is a no-op (the gate below), this is
   * ALL targets.
   */
  readonly mapped: readonly string[];
  /** Controller targets no in-scope test imports (rolled up; never LLM-checked). */
  readonly unmapped: readonly string[];
  /**
   * ONE deterministic finding naming the {@link unmapped} sources, or `null`
   * when there are none. `proposedFix:null` (multi-file → `generate`), so it is
   * exit-neutral — exactly like the per-method findings it replaces.
   */
  readonly rolledUpFinding: Finding | null;
}

/**
 * V1.9.1 (Fix C / I4) — deterministic, NO-LLM triage of the
 * `missing-test-coverage` check's controller targets.
 *
 * Coverage is a STRUCTURAL fact: if no in-scope test references a source
 * module, every public method is trivially uncovered and the per-method LLM
 * call produces only unactionable output (the fix is multi-file → `generate`,
 * which refuses TypeScript this cycle). On the 2026-06-24 `cap_try_ts` run that
 * was ~1/4 of the LLM spend (85 of 89 findings, every one `proposedFix:null`).
 * So spend the LLM call ONLY where an in-scope test exists to compare against;
 * the rest collapse into ONE finding.
 *
 * Mechanism:
 *   1. Parse the imports of every in-scope test file (`.qunit.ts` →
 *      {@link parseEsModuleImports}; `.qunit.js` → {@link parseControllerImports})
 *      into `coveredModuleIds`.
 *   2. For each controller target compute its module id with the SAME
 *      {@link computeModuleId} used for test registration (extension stripped so
 *      a `.ts`/`.js` source matches the extensionless id a test imports). In the
 *      set → `mapped`; not in the set → `unmapped`.
 *   3. Emit `unmapped` as ONE rolled-up finding.
 *
 * Behaviour-boundary notes:
 *   - **GATE — no in-scope tests ⇒ no-op.** When `testFiles` is empty the triage
 *     returns `mapped = controllerTargets`, `unmapped = []`,
 *     `rolledUpFinding = null` — i.e. the original per-method behaviour, leaving
 *     the JS/TS path byte-identical. With nothing in scope to compare against,
 *     an out-of-scope covering test may exist (single-file / changed-files
 *     scope), so we are NOT certain a source is uncovered. Conservative by
 *     design: skip the LLM ONLY when certain. The flood the fix targets is a
 *     full-scope (`--all`) phenomenon, where the in-scope tests ARE the
 *     project's tests.
 *   - **Report-shape change (documented, intended).** For a no-covering-test
 *     source the report now carries ONE rolled-up finding instead of one
 *     finding per uncovered method. The report SCHEMA is unchanged (a new
 *     finding INSTANCE, additive — `schemaVersion` stays `2`); only the
 *     no-covering-test *outcome shape* rolls up. The per-method LLM behaviour
 *     for a source a test DOES import is byte-identical.
 *
 * Read-only: the manifest and the test files are read, nothing is written.
 */
export function triageCoverageTargets(args: {
  readonly projectRoot: string;
  /** Absolute paths of the in-scope controller targets (`scope.controllerJs`). */
  readonly controllerTargets: readonly string[];
  /** Absolute paths of the in-scope qunit test files (`scope.qunitTest`). */
  readonly testFiles: readonly string[];
  readonly projectLanguage?: ProjectLanguage;
}): CoverageTriage {
  // GATE (see the behaviour-boundary note): nothing in scope to compare against
  // ⇒ keep the original per-method behaviour for every target.
  if (args.testFiles.length === 0) {
    return { mapped: args.controllerTargets, unmapped: [], rolledUpFinding: null };
  }
  const coveredModuleIds = buildCoveredModuleIds(args.testFiles);
  const namespace = readManifestNamespace(args.projectRoot);
  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const abs of args.controllerTargets) {
    const rel = toPosix(relative(args.projectRoot, abs));
    const moduleId = computeModuleId({ namespace, fileRel: stripSourceExtension(rel) });
    if (coveredModuleIds.has(moduleId)) mapped.push(abs);
    else unmapped.push(abs);
  }
  const rolledUpFinding =
    unmapped.length > 0
      ? buildRolledUpCoverageFinding(args.projectRoot, unmapped, args.projectLanguage ?? 'js')
      : null;
  return { mapped, unmapped, rolledUpFinding };
}

/** Module ids imported by the in-scope test files (parser chosen by extension). */
function buildCoveredModuleIds(testFiles: readonly string[]): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const abs of testFiles) {
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // a test we cannot read contributes no coverage (conservative).
    }
    // `.qunit.ts` is an ES module; `.qunit.js` is a `sap.ui.define([...])` AMD
    // module. Routing by file extension (not project language) keeps a project
    // with mixed test files correct.
    const imports = /\.ts$/u.test(abs)
      ? parseEsModuleImports(content)
      : parseControllerImports(content);
    for (const id of imports) covered.add(id);
  }
  return covered;
}

/**
 * Strip a source file's `.ts`/`.js` extension so {@link computeModuleId} (which
 * strips only `.js`) yields the extensionless module id a test imports, for
 * both languages — a TS controller is `App.controller.ts`; a test imports
 * `<ns>/.../App.controller`.
 */
function stripSourceExtension(rel: string): string {
  return rel.replace(/\.(?:ts|js)$/u, '');
}

const manifestNamespaceSchema = z
  .object({ 'sap.app': z.object({ id: z.string().min(1) }).passthrough() })
  .passthrough();

/**
 * The project's `sap.app.id` from `webapp/manifest.json`, used as the module-id
 * namespace prefix. Falls back to `'app'` (the same fallback `generate`'s
 * private `readNamespace` uses) when the manifest is absent / unparseable —
 * harmless here, because a wrong namespace only ever makes a source look
 * UNcovered, and the gate already requires in-scope tests for any roll-up.
 *
 * (Sibling of `generate.ts`'s private `readNamespace`; kept local to keep this
 * V1.9.1 hotfix surgical. A shared `readProjectNamespace` extraction is the
 * right follow-up once a third caller appears.)
 */
function readManifestNamespace(projectRoot: string): string {
  const p = join(projectRoot, 'webapp', 'manifest.json');
  if (!existsSync(p)) return 'app';
  try {
    const parsed = manifestNamespaceSchema.safeParse(parseJsonWithBom(readFileSync(p, 'utf8')));
    return parsed.success ? parsed.data['sap.app'].id : 'app';
  } catch {
    return 'app';
  }
}

/** Build the single rolled-up `missing-test-coverage` finding for `unmapped`. */
function buildRolledUpCoverageFinding(
  projectRoot: string,
  unmapped: readonly string[],
  language: ProjectLanguage,
): Finding {
  const rels = unmapped.map((abs) => toPosix(relative(projectRoot, abs))).sort();
  const generateNote =
    language === 'ts'
      ? 'Run `generate` to scaffold the missing tests (generate for TypeScript is deferred to a later release).'
      : 'Run `generate` to scaffold the missing tests.';
  return {
    checkId: 'missing-test-coverage',
    // Representative source file — the report groups findings by `file`; the
    // FULL list is in the explanation. Sorted, so the attribution is stable.
    file: rels[0]!,
    message: `${rels.length} source file(s) have no covering QUnit test (no in-scope test imports them).`,
    source: 'check',
    proposedFix: null,
    explanation:
      `No in-scope QUnit test imports these source files, so every public ` +
      `method is trivially uncovered: ${rels.join(', ')}. ${generateNote}`,
  };
}
