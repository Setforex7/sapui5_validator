/**
 * SPEC §2.1, §2.10 — generate QUnit unit tests for controllers / helpers that
 * lack one.
 *
 * Discovery is intentionally simple: a controller has coverage when a
 * `.qunit.js` file exists at the expected path under `resolveQUnitRoot()`.
 * Whether the existing test asserts anything meaningful is the
 * `missing-test-coverage` check's concern (validate), not generate's.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expectedTestPath } from '../checks/missing-test-coverage.js';
import type { ProjectGraph } from '../project/dependency-graph.js';
import {
  SAP_BUNDLED_SINON_CLAUSE,
  SAP_BUNDLED_SINON_CLAUSE_TS,
  type SinonDialect,
} from '../project/sinon-dialect.js';
import { resolveQUnitRoot, type TestLayout } from '../project/test-layout.js';
import type { ProjectLanguage } from '../project/detect.js';
import type { CallBudget, Sleeper } from '../claude/budget.js';
import type { RateLimitSignal } from '../claude/rate-limit-signal.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { Semaphore } from '../util/concurrency.js';
import {
  generateAndVerify,
  type GenerateContext,
  type GenerateOutcome,
  type ShapeCheckResult,
} from './retry-loop.js';
import { stripJsComments } from '../util/strip-js-comments.js';
import { buildProjectContextLines } from './prompt-context.js';
import {
  computeModuleId,
  registerTest,
  unregisterTest,
  type DiscoveryMode,
  type RegistrationRequest,
} from './registration.js';
import type { VerifyPipelineInput, VerifyResult } from '../verify/pipeline.js';

export interface QunitCandidate {
  readonly controllerAbs: string;
  readonly controllerRel: string;
  readonly expectedTestAbs: string;
  readonly expectedTestRel: string;
}

export function findQunitCandidates(args: {
  readonly projectRoot: string;
  readonly controllers: readonly string[];
  readonly testLayout: TestLayout;
}): readonly QunitCandidate[] {
  const qunitRoot = resolveQUnitRoot(args.testLayout);
  const out: QunitCandidate[] = [];
  for (const controllerAbs of args.controllers) {
    const controllerRel = toPosix(relative(args.projectRoot, controllerAbs));
    const testRel = expectedTestPath(controllerRel, qunitRoot);
    const testAbs = join(args.projectRoot, testRel);
    if (existsSync(testAbs)) continue;
    out.push({
      controllerAbs,
      controllerRel,
      expectedTestAbs: testAbs,
      expectedTestRel: testRel,
    });
  }
  return out;
}

export interface QunitGenerateInput {
  readonly candidate: QunitCandidate;
  readonly projectRoot: string;
  readonly runner: ClaudeRunner;
  readonly budget: CallBudget;
  readonly eslintEnabled: boolean;
  readonly verifyFn: (input: VerifyPipelineInput) => Promise<VerifyResult>;
  readonly namespace: string;
  /**
   * V1.3-4 — how the project discovers test modules. Resolved once by the
   * orchestrator (`detectDiscoveryMode`) and threaded down so each generated
   * QUnit test is registered with the project's karma suite before verify.
   */
  readonly discoveryMode: DiscoveryMode;
  /**
   * V1.3.2-4 — which sinon dialect the project uses. Resolved once by the
   * orchestrator (`detectSinonDialect`) and threaded into both the initial
   * and refinement prompt builders so the LLM steers away from sinon 2.x
   * APIs when the runtime is the karma-ui5-bundled sinon 1.17. See
   * [src/project/sinon-dialect.ts](../project/sinon-dialect.ts).
   */
  readonly sinonDialect: SinonDialect;
  /**
   * V1.4-5 — pre-built project dependency graph. When the candidate
   * controller's `libNamespaces` intersects
   * {@link ProjectGraph.unpreloadedLibs}, the project-context block
   * (with the pre-registered-stub strategy paragraph, AC4) is
   * appended to the initial AND refinement prompts. When the graph
   * is `undefined` or the intersection is empty, the prompts are
   * byte-for-byte identical to the V1.3.2-3 / V1.3.3 baseline (the
   * load-bearing invariant pinned by
   * `test/unit/qunit-prompt-context.test.ts`).
   */
  readonly projectGraph?: ProjectGraph;
  /**
   * V1.6 — the run-wide verify lane, supplied by the orchestrator only on a
   * concurrent run (`--concurrency N>1`). Threaded into {@link GenerateContext}
   * so the register→verify→accept critical section is serialised across
   * workers. Omitted on the sequential default (no lock).
   */
  readonly verifyLane?: Semaphore;
  /**
   * V1.9.2 (TG-LANG-WIRE) — the project's source language, threaded onto
   * {@link GenerateContext} so the per-attempt verify input carries
   * `language: 'ts'` and routes to the static-only TS lane (no karma). Omitted
   * / `'js'` leaves the verify input on the byte-identical JS lane.
   */
  readonly projectLanguage?: ProjectLanguage;
  /**
   * V1.9.2 (TG-LANG-WIRE) — gates the `tsc --noEmit` step on the TS lane (true
   * only when the project ships its own `typescript`). Ignored on the JS lane.
   */
  readonly tscEnabled?: boolean;
  /**
   * V1.9.4 PERF-17 — optional user-selected model, threaded onto
   * {@link GenerateContext} so each generate `claude -p` call forwards
   * `--model`. Unset keeps the call byte-identical to today.
   */
  readonly model?: string;
  readonly signal?: AbortSignal;
  /**
   * COR-13c / V1.9.3 (D2) — injectable backoff sleeper threaded onto
   * {@link GenerateContext} so the per-call rate-limit retry schedule (SPEC
   * §2.12) is deterministic under test. Production leaves it unset (real waits).
   */
  readonly backoffSleeper?: Sleeper;
  /**
   * THR-4 (V1.9.7) — the run-wide pool rate-limit signal, threaded onto
   * {@link GenerateContext} so a 429 backoff on this candidate drains peer
   * dispatch. Supplied by the orchestrator only on a concurrent run
   * (`--concurrency N>1`), alongside {@link verifyLane}; omitted on the
   * sequential default.
   */
  readonly rateLimitSignal?: RateLimitSignal;
}

export async function generateQunitTest(
  input: QunitGenerateInput,
): Promise<GenerateOutcome> {
  const controllerContent = await readFile(input.candidate.controllerAbs, 'utf8');
  const initialPrompt = buildInitialQunitPrompt({
    controllerRel: input.candidate.controllerRel,
    controllerContent,
    expectedTestRel: input.candidate.expectedTestRel,
    namespace: input.namespace,
    sinonDialect: input.sinonDialect,
    ...(input.projectGraph !== undefined
      ? { projectGraph: input.projectGraph }
      : {}),
    // V1.9.2 (TG-PROMPT) — TS framing (```typescript / ESM / .qunit.ts); JS
    // omits the field and stays byte-identical to the frozen baseline.
    ...(input.projectLanguage !== undefined
      ? { projectLanguage: input.projectLanguage }
      : {}),
  });
  const ctx: GenerateContext = {
    projectRoot: input.projectRoot,
    runner: input.runner,
    budget: input.budget,
    eslintEnabled: input.eslintEnabled,
    verifyFn: input.verifyFn,
    // V1.9.2 (TG-LANG-WIRE) — carry the language + tsc gate to the choke point
    // (`retry-loop.ts` spreads them onto the verify input). Conditional spreads
    // keep the JS path byte-identical.
    ...(input.projectLanguage !== undefined
      ? { projectLanguage: input.projectLanguage }
      : {}),
    ...(input.tscEnabled !== undefined ? { tscEnabled: input.tscEnabled } : {}),
    // V1.9.4 PERF-17 — forward the user-selected model when set.
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.projectGraph !== undefined
      ? { projectGraph: input.projectGraph }
      : {}),
    ...(input.verifyLane !== undefined ? { verifyLane: input.verifyLane } : {}),
    ...(input.backoffSleeper !== undefined
      ? { backoffSleeper: input.backoffSleeper }
      : {}),
    ...(input.rateLimitSignal !== undefined
      ? { rateLimitSignal: input.rateLimitSignal }
      : {}),
  };
  // V1.3-4: register the generated test with the project's karma suite so the
  // verify step actually executes it. `registerTest` / `unregisterTest` no-op
  // for `glob-auto` / `unknown` modes (see registration.ts).
  const registration: RegistrationRequest = {
    projectRoot: input.projectRoot,
    mode: input.discoveryMode,
    moduleId: computeModuleId({
      namespace: input.namespace,
      fileRel: input.candidate.expectedTestRel,
    }),
    testFileRel: input.candidate.expectedTestRel,
  };
  // V1.9.2 (TG-ACCEPT / HB-VACUOUS) — the ES specifier of the controller under
  // test (the same id the TS prompt pins). The shape gate requires the generated
  // `.qunit.ts` to reference it, so a test that asserts nothing about the
  // controller cannot be accepted on a static-only (tsc-green) pass.
  const controllerModuleId = computeModuleId({
    namespace: input.namespace,
    fileRel: input.candidate.controllerRel,
  });
  return generateAndVerify(
    {
      initialPrompt,
      buildRefinementPrompt: ({ previousContent, verifyFeedback }) =>
        buildQunitRefinementPrompt({
          controllerRel: input.candidate.controllerRel,
          expectedTestRel: input.candidate.expectedTestRel,
          namespace: input.namespace,
          previousContent,
          verifyFeedback,
          sinonDialect: input.sinonDialect,
          ...(input.projectGraph !== undefined
            ? { projectGraph: input.projectGraph }
            : {}),
          // V1.9.2 (TG-PROMPT) — thread the language to the refinement prompt too
          // (AH4: clauses thread to both prompts) so attempts 2/3 stay ES-module.
          ...(input.projectLanguage !== undefined
            ? { projectLanguage: input.projectLanguage }
            : {}),
        }),
      targetTestFileAbs: input.candidate.expectedTestAbs,
      register: () => registerTest(registration),
      unregister: () => unregisterTest(registration),
      // V1.9.2 (TG-ACCEPT) — TS only: gate static acceptance on the shape check.
      // JS supplies none, so its accept predicate stays `verify.ok` alone.
      ...(input.projectLanguage === 'ts'
        ? { shapeCheck: (content: string) => checkTsTestShape(content, controllerModuleId) }
        : {}),
    },
    ctx,
  );
}

/**
 * V1.9.2 (TG-ACCEPT / HB-VACUOUS, FS-11) — the shape gate for a generated
 * `.qunit.ts`. `tsc --noEmit` proves the test type-checks against the
 * controller's API but NOT that it asserts anything — an `assert.ok(true)` (or
 * empty-body) test is tsc-green. So the TS static-only accept predicate
 * additionally requires the content, after comments are stripped, to:
 *
 *   (a) declare at least one `QUnit.test(...)` (or `QUnit.test.only` /
 *       `QUnit.test.skip` — V1.9.3 D5),
 *   (b) make at least one assertion call (`assert.<method>(...)`),
 *   (c) reference the controller under test by its exact ES module id (the same
 *       specifier {@link buildInitialQunitPromptTs} pins for the import), and
 *   (d) V1.9.9 — NOT mention `sap/ui/thirdparty/qunit-2` anywhere. `@sapui5/types`
 *       declares that module (`export default QUnit`), so an
 *       `import QUnit from "sap/ui/thirdparty/qunit-2"` is tsc-green — but the
 *       ESM→AMD transpile turns it into a second load of qunit-2.js next to the
 *       testsuite HTML's `<script>` tag, double-defining QUnit and killing the
 *       whole suite at runtime. The raw-substring check (post comment-strip)
 *       deliberately catches every spelling: default/named/side-effect imports,
 *       `require`, and re-exports. No legitimate generated test names it.
 *
 * Condition (c) is what makes the gate non-gameable: a `QUnit.test` that only
 * does `assert.ok(true)` and never names the controller is rejected as vacuous.
 * Comments are stripped first so a commented-out test cannot satisfy the gate.
 *
 * V1.9.3 D3 — condition (c)'s *requirement* is unchanged (the exact pinned id is
 * still required for acceptance, so the gate is no less strict), but the
 * rejection *reason* is now honest about WHY a test fails it. A test that DOES
 * exercise the controller, just imported by a relative path / tsconfig alias
 * (its specifier ends in the controller basename), is a *wrong-id conformance
 * miss* — not "vacuous". Only a test that never references the controller at all
 * (or has no `QUnit.test` / no assertion) is genuinely vacuous. The distinction
 * steers refinement to "use the exact id" instead of the false "add assertions".
 * Detecting the basename reference is message-only — it does NOT relax (c).
 *
 * A miss returns `{ ok:false, reason }` (the reason is fed into attempt k+1, not
 * thrown); exported for the fail-on-revert tests.
 */
export function checkTsTestShape(
  content: string,
  controllerModuleId: string,
): ShapeCheckResult {
  const code = stripJsComments(content);
  // (a) — accept the standard QUnit filter forms `.only` / `.skip` too (D5).
  const hasQUnitTest =
    /\bQUnit\s*\.\s*test(?:\s*\.\s*(?:only|skip))?\s*\(/u.test(code);
  // (b) — at least one assertion.
  const hasAssertion = /\bassert\s*\.\s*[A-Za-z]+\s*\(/u.test(code);
  // (c) — the controller imported by its EXACT pinned module id (the only form
  // accepted). `referencesControllerByBasename` is consulted ONLY to phrase the
  // rejection honestly (wrong-id vs. never-referenced); it is not an accept path.
  const importsByExactId = code.includes(controllerModuleId);
  const referencesController =
    importsByExactId || referencesControllerByBasename(code, controllerModuleId);
  // (d) — raw substring on purpose: any mention of the qunit-2 specifier
  // (default/named/side-effect import, require, re-export) is the double-define
  // hazard; no legitimate generated test names it.
  const importsQunit2 = code.includes('sap/ui/thirdparty/qunit-2');

  const missing: string[] = [];
  if (!hasQUnitTest) missing.push('at least one QUnit.test(...) block');
  if (!hasAssertion) {
    missing.push('at least one assertion (e.g. assert.ok / assert.strictEqual)');
  }
  if (!importsByExactId) {
    missing.push(
      referencesController
        ? // D3: references the controller, just not by the pinned id — name the
          // exact-id requirement so refinement fixes the import, not the asserts.
          `an import of the controller under test by its EXACT module id ` +
            `("${controllerModuleId}") — the test imports it by a relative path ` +
            `or tsconfig alias, which the static shape check does not accept`
        : `a reference to the controller under test ("${controllerModuleId}")`,
    );
  }
  if (missing.length === 0 && !importsQunit2) return { ok: true };

  // (d)'s sentence is APPENDED to whichever reason fires (never a separate
  // rejection round): with MAX_GENERATE_ATTEMPTS = 3, one feedback message must
  // name every defect at once. The "sinon stays" caveat blocks the model from
  // over-generalising the ban onto the legitimate sinon module import.
  const qunit2Sentence =
    `The test mentions "sap/ui/thirdparty/qunit-2" — forbidden: QUnit is a ` +
    `pre-loaded browser global (the testsuite HTML loads qunit-2.js via a ` +
    `<script> tag), so importing that module loads QUnit a second time at ` +
    `runtime and breaks the whole suite. Delete the import and reference the ` +
    `QUnit global directly (a sinon import is a real module and must stay).`;
  if (missing.length === 0) return { ok: false, reason: qunit2Sentence };

  // "Vacuous" is reserved for a test that genuinely proves nothing about the
  // controller — no `QUnit.test`, no assertion, or no reference to the controller
  // at all. A test that exercises the controller but imports it by the wrong
  // specifier is a conformance miss, so it gets a wrong-id steer (D3), not the
  // false "vacuous / add assertions" steer that mis-guided refinement.
  const provesSomethingAboutController =
    hasQUnitTest && hasAssertion && referencesController;
  const reason = provesSomethingAboutController
    ? `The generated test exercises the controller but does not import it by ` +
      `its exact pinned module id. It must contain ${missing.join(', ')}. Import ` +
      `the controller with EXACTLY the id "${controllerModuleId}" (unchanged — ` +
      `not a relative path or tsconfig alias), then assert on its behaviour.`
    : 'The generated test type-checks but is vacuous (it proves nothing about ' +
      `the controller under test). It must contain ${missing.join(', ')}. Add a ` +
      `QUnit.test that imports "${controllerModuleId}", constructs it, and ` +
      'asserts on its behaviour.';
  return {
    ok: false,
    reason: importsQunit2 ? `${reason} ${qunit2Sentence}` : reason,
  };
}

/**
 * V1.9.3 D3 — does `code` reference the controller under test by a specifier
 * whose final path segment is the controller's basename (e.g. a relative
 * `"../controller/App.controller"` or a tsconfig alias `"@app/App.controller"`)?
 * Used ONLY to phrase the shape-check rejection honestly: a test that imports the
 * controller this way exercises it (so it is a wrong-id conformance miss, not a
 * vacuous test) but still fails condition (c), which requires the EXACT pinned
 * module id. This does NOT relax (c) — acceptance still demands the exact id; it
 * only routes the message. Full `tsconfig` `paths` resolution is out of patch
 * scope (it would need TS module-resolution logic).
 */
function referencesControllerByBasename(
  code: string,
  controllerModuleId: string,
): boolean {
  const basename = controllerModuleId.slice(
    controllerModuleId.lastIndexOf('/') + 1,
  );
  if (basename.length === 0) return false;
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // The specifier must END with `/<basename>` at the closing quote, so a token
  // that merely contains the basename mid-path does not count.
  return new RegExp(`/${escaped}["'\`]`, 'u').test(code);
}

export interface QunitPromptArgs {
  readonly controllerRel: string;
  readonly controllerContent: string;
  readonly expectedTestRel: string;
  readonly namespace: string;
  /**
   * V1.3.2-4 — when `'sap-bundled'`, append {@link SAP_BUNDLED_SINON_CLAUSE}
   * to the prompt. `'modern'` and `'unknown'` produce byte-for-byte identical
   * prompts to the V1.3.2-3 baseline.
   */
  readonly sinonDialect: SinonDialect;
  /**
   * V1.4-5 (AC4, AH3) — when supplied AND the controller's
   * `libNamespaces` intersect the graph's `unpreloadedLibs`, the
   * pre-registered-stub project-context block is appended after the
   * controller source and before the schema instruction. When
   * omitted OR the intersection is empty, the prompt is byte-for-byte
   * identical to the V1.3.2-3 / V1.3.3 baseline.
   */
  readonly projectGraph?: ProjectGraph;
  /**
   * V1.9.2 (TG-PROMPT) — the project's source language. When `'ts'`, the prompt
   * is TS-framed: a ` ```typescript ` fence, ES-module/class guidance, a request
   * for a `.qunit.ts` file, and the controller imported by its ES specifier — NOT
   * `sap.ui.define` AMD. The AMD unpreloaded-stub project-context block is
   * JS-only and is NOT spliced for TS (TG-STUB-CONSIST). When omitted / `'js'`
   * the prompt is byte-for-byte identical to the frozen JS baseline.
   */
  readonly projectLanguage?: ProjectLanguage;
}

export function buildInitialQunitPrompt(args: QunitPromptArgs): string {
  // V1.9.2 (TG-PROMPT) — a TS project gets an ES-module/`.qunit.ts` contract.
  // The JS branch below is left byte-identical to the frozen baseline.
  if (args.projectLanguage === 'ts') {
    return buildInitialQunitPromptTs(args);
  }
  // V1.6 — pin the EXACT module id of the controller under test. The LLM
  // otherwise derives the import from the file path and intermittently drops
  // the `.controller` segment of a `*.controller.js` file — importing
  // `<ns>/controller/App` (→ `controller/App.js`, which does not exist) instead
  // of `<ns>/controller/App.controller`. That 404s, the test page hangs, and
  // karma's browserNoActivityTimeout fires → a spurious module-load quarantine.
  // `computeModuleId` is the same deterministic source of truth used for test
  // registration, so it keeps the `.controller` segment exactly.
  const controllerModuleId = computeModuleId({
    namespace: args.namespace,
    fileRel: args.controllerRel,
  });
  const lines: string[] = [
    'Task: generate a QUnit unit test file for the following SAPUI5 controller.',
    '',
    `Controller path: ${args.controllerRel}`,
    `Test file to create: ${args.expectedTestRel}`,
    `Project namespace: ${args.namespace}`,
    `Controller module id (import the controller under test with EXACTLY this id, unchanged): ${controllerModuleId}`,
    '',
    'Controller source:',
    '```javascript',
    // V1.9.4 PERF-3 — strip comments from the embedded source (PROMPT ONLY; the
    // on-disk controller + the audit transcript keep the raw bytes). Length-
    // preserving, so the 1-based line numbers the model is asked to report still
    // map onto the original file.
    stripJsComments(args.controllerContent),
    '```',
    '',
    'Requirements:',
    '  - Use `sap.ui.define([...], function (...) { ... })`.',
    '  - Import the controller under test by the exact "Controller module id" shown',
    '    above. Do NOT add, drop, or rename any path segment (a `*.controller.js`',
    '    file keeps its trailing `.controller`).',
    '  - Use the `QUnit.module(name, { beforeEach, afterEach })` hook to',
    '    construct the controller instance under test and dispose of any',
    '    SAPUI5 controls created in `beforeEach` via `destroy()` in',
    '    `afterEach` (SPEC §2.8 check #3 forbids leaks).',
    '  - Add a `QUnit.test` for each public method on the controller',
    '    (including lifecycle hooks `onInit`, `onExit`, `onBefore/AfterRendering`),',
    '    except methods whose name begins with `_`.',
    '  - Each test must assert something concrete (`assert.ok` / `assert.equal` /',
    '    `assert.strictEqual` / `assert.deepEqual`). No empty test bodies.',
    '  - Do NOT call browser-only APIs (`document.*`, `window.*`) directly.',
    '  - Do NOT introduce new dependencies beyond `sap.ui.*` modules.',
  ];
  // V1.4-5 (AH3) — splice with leading + trailing blank lines so the
  // empty-gap path stays byte-for-byte identical to the v0.4.2 baseline.
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
  lines.push('{ "newFileContent": "<complete contents of the .qunit.js file>" }');
  lines.push('No prose, no markdown fences.');
  if (args.sinonDialect === 'sap-bundled') {
    lines.push(SAP_BUNDLED_SINON_CLAUSE);
  }
  return lines.join('\n');
}

/**
 * V1.9.2 (TG-PROMPT / FS-4) — the TypeScript variant of the initial QUnit
 * prompt. A TS-SAPUI5 project authors controllers and tests as native ES modules
 * (`import`/`export class`), transpiled by the project's own toolchain — so a
 * generated test must be a `.qunit.ts` ES module, never `sap.ui.define` AMD
 * (which would corrupt the project's module shape). The controller-under-test is
 * imported by its ES specifier, which is exactly `computeModuleId(controllerRel)`
 * once the `.ts` is stripped (TG-MODULEID) — the SAME pin the JS path uses, so a
 * `*.controller.ts` keeps its trailing `.controller`. The AMD unpreloaded-stub
 * project-context block (`buildProjectContextLines`) is JS-only and is
 * deliberately NOT spliced here (TG-STUB-CONSIST); unpreloaded-libs is gated off
 * for TS (V1.9.1 D1/D2), so no gap reaches this path in production anyway.
 */
function buildInitialQunitPromptTs(args: QunitPromptArgs): string {
  const controllerModuleId = computeModuleId({
    namespace: args.namespace,
    fileRel: args.controllerRel,
  });
  const lines: string[] = [
    'Task: generate a QUnit unit test file for the following SAPUI5 TypeScript controller.',
    '',
    `Controller path: ${args.controllerRel}`,
    `Test file to create: ${args.expectedTestRel}`,
    `Project namespace: ${args.namespace}`,
    `Controller module id (import the controller under test with EXACTLY this id, unchanged): ${controllerModuleId}`,
    '',
    'Controller source:',
    '```typescript',
    // V1.9.4 PERF-3 — see the JS twin above; stripping is length-preserving and
    // correct on TS source (comments/strings/template literals are lexically
    // identical in JS and TS — strip-js-comments.ts GA1-09).
    stripJsComments(args.controllerContent),
    '```',
    '',
    'Requirements:',
    '  - This is a TypeScript SAPUI5 project. Write the test as a native ES',
    '    module using `import`/`export` with a `QUnit.module` / `QUnit.test`',
    '    structure. Do NOT use the AMD `sap.ui.define(...)` wrapper — that is the',
    '    JavaScript-project shape and breaks an ES-module TypeScript project.',
    '  - Import the controller under test as an ES default import by the exact',
    '    "Controller module id" shown above:',
    '    `import <ControllerClass> from "<that id>"`. Do NOT add, drop, or rename',
    '    any path segment (a `*.controller.ts` file keeps its trailing',
    '    `.controller`).',
    // V1.9.9 — QUnit must stay the ambient global. The bullet this replaces
    // licensed `import QUnit from "sap/ui/thirdparty/qunit-2"`, which the
    // project's ESM→AMD transpile turns into a SECOND execution of qunit-2.js
    // next to the testsuite HTML's <script> tag — "QUnit has already been
    // defined", every module resolve fails, QUnit.start() never fires. Mirrored
    // in the refinement prompt and enforced by checkTsTestShape condition (d).
    '  - Do NOT import QUnit — not from `"sap/ui/thirdparty/qunit-2"` nor any',
    '    other module. `QUnit` is a pre-loaded browser global (the testsuite',
    '    HTML loads `qunit-2.js` via a `<script>` tag); importing it loads QUnit',
    '    a second time at runtime and breaks every test in the suite. Reference',
    '    the `QUnit` global directly. This applies to QUnit ONLY — a sinon',
    '    import (if instructed below) is a real module and must stay.',
    '  - Use the `QUnit.module(name, { beforeEach, afterEach })` hook to',
    '    construct the controller instance under test and dispose of any',
    '    SAPUI5 controls created in `beforeEach` via `destroy()` in',
    '    `afterEach` (SPEC §2.8 check #3 forbids leaks).',
    '  - Add a `QUnit.test` for each public method on the controller',
    '    (including lifecycle hooks `onInit`, `onExit`, `onBefore/AfterRendering`),',
    '    except methods whose name begins with `_`.',
    '  - Each test must assert something concrete (`assert.ok` / `assert.equal` /',
    '    `assert.strictEqual` / `assert.deepEqual`). No empty test bodies.',
    '  - Do NOT call browser-only APIs (`document.*`, `window.*`) directly.',
    '  - Do NOT introduce new dependencies beyond `sap/ui/*` modules and the',
    '    controller under test.',
    '',
    'Return ONLY a single JSON object of the shape:',
    '{ "newFileContent": "<complete contents of the .qunit.ts file>" }',
    'No prose, no markdown fences.',
  ];
  // V1.9.3 (D4) — splice the ES-module sinon clause, NOT the AMD one. The JS twin
  // (`SAP_BUNDLED_SINON_CLAUSE`) mandates the `sap.ui.define` dependency array,
  // which contradicts this prompt's anti-AMD instruction; `SAP_BUNDLED_SINON_CLAUSE_TS`
  // carries the same 1.17-vs-2.x guidance with an ES `import` form.
  if (args.sinonDialect === 'sap-bundled') {
    lines.push(SAP_BUNDLED_SINON_CLAUSE_TS);
  }
  return lines.join('\n');
}

export function buildQunitRefinementPrompt(args: {
  readonly controllerRel: string;
  readonly expectedTestRel: string;
  /**
   * R1.7a (AUDIT §5.7a) — needed to recompute the controller module id so
   * the `EXACTLY this id` pin threads into the refinement prompt too (AH4:
   * clauses thread to BOTH prompts). Without it, attempts 2/3 could re-drop
   * the `.controller` segment and recreate the 0.7.0 wrong-import bug as a
   * spurious module-load quarantine.
   */
  readonly namespace: string;
  readonly previousContent: string;
  readonly verifyFeedback: string;
  /**
   * V1.3.2-4 — AH4: the refinement prompt must carry the sinon-dialect
   * clause too; without this, attempts 2 and 3 repeat the same dialect
   * mistake as attempt 1 because the LLM has no reminder. `'modern'` /
   * `'unknown'` produce byte-for-byte identical prompts to the V1.3.2-3
   * baseline.
   */
  readonly sinonDialect: SinonDialect;
  /**
   * V1.4-5 (AP4) — the project-context block is added to both initial
   * and refinement prompts per V1.3.2-4 AH4 discipline (clauses thread
   * to both prompts for consistency). For module-load failures the
   * refinement loop never runs (V1.3.3-5 short-circuit fires first),
   * so the block is inert for that case; for other failure modes
   * (eslint / ui5lint / ordinary test assertion failures) it provides
   * context if the LLM attempts a fix that incidentally needs the
   * project-graph awareness.
   */
  readonly projectGraph?: ProjectGraph;
  /**
   * V1.9.2 (TG-PROMPT) — when `'ts'`, the refinement prompt is TS-framed (a
   * ` ```typescript ` fence + a `.qunit.ts` schema line, no AMD context block),
   * mirroring the initial prompt so attempts 2/3 do not drift back to AMD. JS is
   * byte-identical.
   */
  readonly projectLanguage?: ProjectLanguage;
}): string {
  if (args.projectLanguage === 'ts') {
    return buildQunitRefinementPromptTs(args);
  }
  const controllerModuleId = computeModuleId({
    namespace: args.namespace,
    fileRel: args.controllerRel,
  });
  const lines: string[] = [
    'Your previous QUnit test did not pass verification.',
    '',
    `Controller: ${args.controllerRel}`,
    `Test file: ${args.expectedTestRel}`,
    `Controller module id (import the controller under test with EXACTLY this id, unchanged): ${controllerModuleId}`,
    '',
    'Previous test content:',
    '```javascript',
    args.previousContent,
    '```',
    '',
    'Verification output (raw):',
    '```',
    args.verifyFeedback,
    '```',
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
  lines.push('{ "newFileContent": "<corrected complete .qunit.js file content>" }');
  lines.push('No prose, no markdown fences.');
  if (args.sinonDialect === 'sap-bundled') {
    lines.push(SAP_BUNDLED_SINON_CLAUSE);
  }
  return lines.join('\n');
}

/**
 * V1.9.2 (TG-PROMPT) — the TypeScript refinement prompt. Mirrors
 * {@link buildInitialQunitPromptTs}: ES-module framing, a ` ```typescript ` fence
 * over the previous content, the controller-id pin (AH4 — threads to BOTH
 * prompts so attempts 2/3 cannot re-introduce AMD), and a `.qunit.ts` schema
 * line. No AMD project-context block (TG-STUB-CONSIST).
 */
function buildQunitRefinementPromptTs(args: {
  readonly controllerRel: string;
  readonly expectedTestRel: string;
  readonly namespace: string;
  readonly previousContent: string;
  readonly verifyFeedback: string;
  readonly sinonDialect: SinonDialect;
  readonly projectGraph?: ProjectGraph;
  readonly projectLanguage?: ProjectLanguage;
}): string {
  const controllerModuleId = computeModuleId({
    namespace: args.namespace,
    fileRel: args.controllerRel,
  });
  const lines: string[] = [
    'Your previous QUnit test did not pass verification.',
    '',
    `Controller: ${args.controllerRel}`,
    `Test file: ${args.expectedTestRel}`,
    `Controller module id (import the controller under test with EXACTLY this id, unchanged): ${controllerModuleId}`,
    '',
    'Previous test content:',
    '```typescript',
    args.previousContent,
    '```',
    '',
    'Verification output (raw):',
    '```',
    args.verifyFeedback,
    '```',
    '',
    'Keep the test a native ES module (`import`/`export`, `QUnit.module`/',
    '`QUnit.test`) — do NOT switch to `sap.ui.define` AMD.',
    // V1.9.9 — the QUnit-global contract threads to BOTH prompts (AH4), or
    // attempts 2/3 could reintroduce the double-define the initial prompt bans.
    'Do NOT import QUnit (`"sap/ui/thirdparty/qunit-2"` or otherwise) — `QUnit`',
    'is a pre-loaded browser global; importing it loads QUnit a second time at',
    'runtime and breaks the whole suite. Reference the global directly. This',
    'applies to QUnit ONLY — a sinon import is a real module and must stay.',
    '',
    'Return ONLY a single JSON object of the shape:',
    '{ "newFileContent": "<corrected complete .qunit.ts file content>" }',
    'No prose, no markdown fences.',
  ];
  // V1.9.3 (D4) — ES-module sinon clause on the TS refinement path too (AH4: the
  // dialect clause threads to BOTH prompts so attempts 2/3 do not regress to AMD).
  if (args.sinonDialect === 'sap-bundled') {
    lines.push(SAP_BUNDLED_SINON_CLAUSE_TS);
  }
  return lines.join('\n');
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
