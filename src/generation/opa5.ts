/**
 * SPEC §2.1, §2.10 — generate OPA5 journey files for view+controller pairs
 * that lack one.
 *
 * Discovery: every `webapp/**\/*.view.xml` is paired with the controller it
 * declares via `controllerName="<ns>.controller.<Name>"`. A candidate is
 * produced when both files exist and no journey file exists yet under
 * `webapp/test/integration/<Name>Journey.qunit.js`. The orchestrator can skip
 * OPA5 generation entirely when the discovery list is empty.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import type { ProjectGraph } from '../project/dependency-graph.js';
import type { TestLayout } from '../project/test-layout.js';
import { FALLBACK_LAYOUT } from '../project/test-layout.js';
import type { CallBudget } from '../claude/budget.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { Semaphore } from '../util/concurrency.js';
import type { RateLimitSignal } from '../claude/rate-limit-signal.js';
import {
  computeModuleId,
  unregisterTest,
  type DiscoveryMode,
  type RegistrationRequest,
} from './registration.js';
import {
  generateAndVerify,
  type GenerateContext,
  type GenerateOutcome,
} from './retry-loop.js';
import { buildProjectContextLines } from './prompt-context.js';
import { stripJsComments } from '../util/strip-js-comments.js';
import { resolveControllerRelFromView } from '../project/controller-resolve.js';
import type { VerifyPipelineInput, VerifyResult } from '../verify/pipeline.js';

export interface Opa5Candidate {
  readonly viewAbs: string;
  readonly viewRel: string;
  readonly controllerAbs: string;
  readonly controllerRel: string;
  readonly viewName: string;
  readonly journeyTestAbs: string;
  readonly journeyTestRel: string;
}

export function findOpa5Candidates(args: {
  readonly projectRoot: string;
  readonly views: readonly string[];
  readonly testLayout: TestLayout;
}): readonly Opa5Candidate[] {
  const opaRoot = opa5RootFromLayout(args.testLayout);
  const out: Opa5Candidate[] = [];
  for (const viewAbs of args.views) {
    const viewRel = toPosix(relative(args.projectRoot, viewAbs));
    const viewName = baseName(viewAbs).replace(/\.view\.xml$/u, '');
    const controllerRel = controllerRelFromView(viewAbs, args.projectRoot);
    if (controllerRel === null) continue;
    const controllerAbs = join(args.projectRoot, controllerRel);
    if (!existsSync(controllerAbs)) continue;
    const journeyRel = `${opaRoot}/${viewName}Journey.qunit.js`;
    const journeyAbs = join(args.projectRoot, journeyRel);
    if (existsSync(journeyAbs)) continue;
    out.push({
      viewAbs,
      viewRel,
      controllerAbs,
      controllerRel,
      viewName,
      journeyTestAbs: journeyAbs,
      journeyTestRel: journeyRel,
    });
  }
  return out;
}

function opa5RootFromLayout(layout: TestLayout): string {
  // SPEC §2.7 falls back to `webapp/test/integration` when karma config does
  // not indicate otherwise. Karma globs that include `integration/` are
  // respected by extracting the literal prefix before the wildcard.
  const globs = layout.karma?.testFileGlobs ?? [];
  for (const g of globs) {
    if (!g.includes('integration')) continue;
    const ix = g.search(/\/\*\*|\*/);
    if (ix <= 0) continue;
    let root = g.slice(0, ix);
    while (root.endsWith('/')) root = root.slice(0, -1);
    if (root.length > 0) return root;
  }
  return FALLBACK_LAYOUT.opa5;
}

function controllerRelFromView(viewAbs: string, projectRoot: string): string | null {
  let xml: string;
  try {
    xml = readFileSync(viewAbs, 'utf8');
  } catch {
    return null;
  }
  // COR-6: shared layout-aware resolution (namespace-prefix strip + last
  // `controller` segment). The pre-COR-6 first-`controller` slice misfired on a
  // namespace segment literally named `controller`; the shared resolver does
  // not, and also gates on the file existing.
  return resolveControllerRelFromView({ projectRoot, viewContent: xml });
}

export interface Opa5GenerateInput {
  readonly candidate: Opa5Candidate;
  readonly projectRoot: string;
  readonly runner: ClaudeRunner;
  readonly budget: CallBudget;
  readonly eslintEnabled: boolean;
  readonly verifyFn: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  readonly namespace: string;
  /**
   * R2.5 (AUDIT §5.7c) — how the project discovers test modules, threaded
   * for quarantine containment parity with QUnit. Journeys are still NOT
   * auto-registered (SPEC §2.1 — no `register` is passed), but a quarantined
   * journey must be UN-registered: on a `glob-auto` project the broad
   * `files:` glob matches `*Journey.qunit.js`, so without the
   * `ensureFailingExcluded` exclude the quarantined file is re-collected on
   * the next run and poisons its baseline (`baseline-failed`).
   */
  readonly discoveryMode: DiscoveryMode;
  /**
   * V1.4-5 (AM6) — pre-built project dependency graph. Threaded into
   * both the initial and refinement OPA5 prompts. The
   * project-context block is a project-graph statement (graph-
   * derived), NOT a sinon clause; the OPA5 sinon-dialect parity (the
   * `SAP_BUNDLED_SINON_CLAUSE` analogue) stays deferred to V1.5+.
   * When `undefined` or the controller has no unpreloaded-lib
   * intersection, prompts are byte-for-byte identical to baseline.
   */
  readonly projectGraph?: ProjectGraph;
  /**
   * V1.6 — the run-wide verify lane, supplied by the orchestrator only on a
   * concurrent run (`--concurrency N>1`); threaded into the generate context so
   * register→verify→accept is serialised across workers. Omitted on the
   * sequential default.
   */
  readonly verifyLane?: Semaphore;
  /**
   * V1.9.4 PERF-17 — optional user-selected model, threaded onto
   * {@link GenerateContext} so each generate `claude -p` call forwards
   * `--model`. Unset keeps the call byte-identical to today.
   */
  readonly model?: string;
  readonly signal?: AbortSignal;
  /**
   * THR-4 (V1.9.7) — the run-wide pool rate-limit signal, threaded onto
   * {@link GenerateContext} so a 429 backoff on this journey drains peer
   * dispatch. Supplied by the orchestrator only on a concurrent run
   * (`--concurrency N>1`), alongside {@link verifyLane}; omitted on the
   * sequential default.
   */
  readonly rateLimitSignal?: RateLimitSignal;
}

export async function generateOpa5Journey(
  input: Opa5GenerateInput,
): Promise<GenerateOutcome> {
  const [viewContent, controllerContent] = await Promise.all([
    readFile(input.candidate.viewAbs, 'utf8'),
    readFile(input.candidate.controllerAbs, 'utf8'),
  ]);
  const initialPrompt = buildInitialOpa5Prompt({
    namespace: input.namespace,
    viewRel: input.candidate.viewRel,
    viewName: input.candidate.viewName,
    viewContent,
    controllerRel: input.candidate.controllerRel,
    controllerContent,
    journeyRel: input.candidate.journeyTestRel,
    ...(input.projectGraph !== undefined
      ? { projectGraph: input.projectGraph }
      : {}),
  });
  const ctx: GenerateContext = {
    projectRoot: input.projectRoot,
    runner: input.runner,
    budget: input.budget,
    eslintEnabled: input.eslintEnabled,
    verifyFn: input.verifyFn,
    // V1.9.4 PERF-17 — forward the user-selected model when set.
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.projectGraph !== undefined
      ? { projectGraph: input.projectGraph }
      : {}),
    ...(input.verifyLane !== undefined ? { verifyLane: input.verifyLane } : {}),
    ...(input.rateLimitSignal !== undefined
      ? { rateLimitSignal: input.rateLimitSignal }
      : {}),
  };
  // R2.5 (AUDIT §5.7c) — quarantine containment parity with QUnit. No
  // `register` (OPA5 journey registration stays out of V1 scope — SPEC
  // §2.1), but `unregister` IS threaded so the quarantine path fires
  // `ensureFailingExcluded` on glob-auto projects (the only mode where the
  // never-registered journey is nonetheless collected, via the broad glob).
  // On testsuite-require / karma-files-glob the unregister is an idempotent
  // no-op (the journey was never in the discovery array).
  const registration: RegistrationRequest = {
    projectRoot: input.projectRoot,
    mode: input.discoveryMode,
    moduleId: computeModuleId({
      namespace: input.namespace,
      fileRel: input.candidate.journeyTestRel,
    }),
    testFileRel: input.candidate.journeyTestRel,
  };
  return generateAndVerify(
    {
      initialPrompt,
      buildRefinementPrompt: ({ previousContent, verifyFeedback }) =>
        buildOpa5RefinementPrompt({
          viewName: input.candidate.viewName,
          journeyRel: input.candidate.journeyTestRel,
          controllerRel: input.candidate.controllerRel,
          previousContent,
          verifyFeedback,
          ...(input.projectGraph !== undefined
            ? { projectGraph: input.projectGraph }
            : {}),
        }),
      targetTestFileAbs: input.candidate.journeyTestAbs,
      unregister: () => unregisterTest(registration),
    },
    ctx,
  );
}

export interface Opa5PromptArgs {
  readonly namespace: string;
  readonly viewRel: string;
  readonly viewName: string;
  readonly viewContent: string;
  readonly controllerRel: string;
  readonly controllerContent: string;
  readonly journeyRel: string;
  /**
   * V1.4-5 (AM6) — when supplied AND the controller's `libNamespaces`
   * intersect the graph's `unpreloadedLibs`, append the project-
   * context block (with the pre-registered-stub strategy). Omit
   * preserves byte-for-byte parity with V1.3.x baseline.
   */
  readonly projectGraph?: ProjectGraph;
}

export function buildInitialOpa5Prompt(args: Opa5PromptArgs): string {
  const lines: string[] = [
    'Task: generate an OPA5 journey (integration test) file for the SAPUI5',
    'view + controller pair below.',
    '',
    `Namespace: ${args.namespace}`,
    `View path: ${args.viewRel}`,
    `Controller path: ${args.controllerRel}`,
    `Journey file to create: ${args.journeyRel}`,
    '',
    // V1.9.4 PERF-11 — a regex surface summary replaces the full view XML embed.
    // An OPA5 journey is driven by control ids + press handlers + bound text, not
    // the 5–20 KB nested layout tree; the full XML stays in the audit trail. A
    // missed id only yields a refinable karma failure (verify-then-accept catches
    // it), and the extraction is depth-agnostic so that does not happen anyway.
    'View surface (regex summary — control ids, press handlers, and bound text;',
    'the full view XML is in the audit trail, not embedded here to save tokens):',
    summarizeViewSurface(args.viewContent),
    '',
    'Controller source:',
    '```javascript',
    // V1.9.4 PERF-3 — strip comments from the embedded controller (PROMPT ONLY;
    // the on-disk file + audit transcript keep the raw bytes).
    stripJsComments(args.controllerContent),
    '```',
    '',
    'Requirements:',
    '  - Use `sap.ui.define(["sap/ui/test/Opa5", "sap/ui/test/opaQunit"], ...)`.',
    '  - Define page objects with `Opa5.createPageObjects({...})` if the journey',
    '    needs more than one action/assertion site.',
    '  - Use `opaTest(...)` blocks. Each must end with `iTeardownMyApp` (or',
    '    `iTeardownMyAppFrame` when the host fixture is iframe-based) to satisfy',
    '    OPA5 cleanup (SPEC §2.8 check #3).',
    '  - Reference SAPUI5 controls via `sap.ui.test.matchers.*` matchers, never',
    '    direct DOM selectors.',
    '  - Cover at least the primary press handler exposed by the controller',
    '    when one exists; otherwise cover navigation/initial rendering.',
  ];
  const contextLines = buildProjectContextLines({
    projectGraph: args.projectGraph,
    controllerRel: args.controllerRel,
  });
  if (contextLines.length > 0) {
    lines.push('');
    lines.push(...contextLines);
  }
  lines.push('');
  lines.push('Return ONLY a single JSON object of the shape:');
  lines.push('{ "newFileContent": "<complete contents of the journey .qunit.js file>" }');
  lines.push('No prose, no markdown fences.');
  return lines.join('\n');
}

export function buildOpa5RefinementPrompt(args: {
  readonly viewName: string;
  readonly journeyRel: string;
  /**
   * V1.4-5 — added so the refinement prompt can derive the project-
   * context block when the paired controller intersects the graph's
   * unpreloaded-lib gap. Optional for unit-test flexibility; the
   * orchestrator always supplies it.
   */
  readonly controllerRel?: string;
  readonly previousContent: string;
  readonly verifyFeedback: string;
  /** V1.4-5 (AM6 / AP4) — see {@link Opa5GenerateInput.projectGraph}. */
  readonly projectGraph?: ProjectGraph;
}): string {
  const lines: string[] = [
    'Your previous OPA5 journey did not pass verification.',
    '',
    `View: ${args.viewName}`,
    `Journey file: ${args.journeyRel}`,
    '',
    'Previous journey content:',
    '```javascript',
    args.previousContent,
    '```',
    '',
    'Verification output (raw):',
    '```',
    args.verifyFeedback,
    '```',
  ];
  if (args.controllerRel !== undefined) {
    const contextLines = buildProjectContextLines({
      projectGraph: args.projectGraph,
      controllerRel: args.controllerRel,
    });
    if (contextLines.length > 0) {
      lines.push('');
      lines.push(...contextLines);
    }
  }
  lines.push('');
  lines.push('Return ONLY a single JSON object of the shape:');
  lines.push('{ "newFileContent": "<corrected complete journey content>" }');
  lines.push('No prose, no markdown fences.');
  return lines.join('\n');
}

/**
 * V1.9.4 PERF-11 — reduce a view XML embed to the surface an OPA5 journey needs:
 * the root control type, every control `id`, every `press` handler, and every
 * BOUND `text="{…}"` label — extracted at ALL nesting depths. The full XML
 * (5–20 KB of layout the model does not act on) stays in the audit trail; only
 * this ~few-hundred-char summary is sent. XML comments are stripped first so a
 * commented-out `<Foo id="x"/>` cannot leak a phantom id into the summary.
 *
 * Depth-agnostic by construction (a single global attribute scan over the whole
 * document, not a tree walk), so no nested id/press is dropped — the property the
 * fail-on-revert test pins. Exported for that test.
 */
export function summarizeViewSurface(viewContent: string): string {
  const xml = viewContent.replace(/<!--[\s\S]*?-->/gu, '');
  // First real element tag (the `[A-Za-z]` after `<` skips `<?xml …?>` and `<!…>`).
  const rootTag = /<\s*([A-Za-z_][\w.:-]*)/u.exec(xml)?.[1] ?? '(unknown)';
  const ids = collectAttr(xml, 'id');
  const presses = collectAttr(xml, 'press');
  const boundTexts = collectAttr(xml, 'text').filter(
    (v) => v.startsWith('{') && v.endsWith('}'),
  );
  const fmt = (values: readonly string[]): string =>
    values.length > 0 ? values.join(', ') : '(none)';
  return [
    `  Root control: ${rootTag}`,
    `  Control ids: ${fmt(ids)}`,
    `  Press handlers: ${fmt(presses)}`,
    `  Bound text: ${fmt(boundTexts)}`,
  ].join('\n');
}

/**
 * All values of attribute `attr` across the XML, at any depth, in document order.
 * Handles both `"…"` and `'…'` quoting (SAPUI5 views use double quotes, but the
 * single-quote form is valid XML and cheap to cover).
 */
function collectAttr(xml: string, attr: string): string[] {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gu');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = m[1] ?? m[2];
    if (value !== undefined) out.push(value);
  }
  return out;
}

function baseName(p: string): string {
  return basename(p);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
