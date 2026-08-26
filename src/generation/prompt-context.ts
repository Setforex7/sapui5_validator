/**
 * V1.4-5 — shared project-context block appended to both QUnit and OPA5
 * generation prompts when the project's
 * {@link ../project/dependency-graph.ts | ProjectGraph} reports
 * unpreloaded libraries touching the current controller's
 * `sap.ui.define` imports.
 *
 * The block is **mechanically derived from the graph** — no hand-
 * curated knowledge. It tells the LLM:
 *   1. what the manifest declares;
 *   2. what (if anything) karma.conf.js `client.libs` overrides;
 *   3. which controller-imported libs will NOT preload at karma-ui5
 *      runtime (the predicted gap);
 *   4. a fixed-wording "pre-registered stub module" strategy
 *      paragraph (AC4) explaining how to stub the unloadable module
 *      BEFORE the test's `sap.ui.define` runs so karma's loader
 *      resolves it from cache.
 *
 * Behaviour-boundary notes:
 *   - **Gap-empty-omits-block.** Returns `[]` when the current
 *     controller's `libNamespaces` does not intersect the project's
 *     `unpreloadedLibs`. Callers conditionally splice this in with a
 *     leading AND trailing blank line so the empty-gap path produces
 *     a prompt byte-for-byte identical to the V1.3.2-3 / V1.3.3
 *     baseline (the load-bearing invariant pinned by
 *     `test/unit/qunit-prompt-context.test.ts` /
 *     `test/unit/opa5-prompt-context.test.ts` via the committed
 *     `test/fixtures/prompts/qunit-initial-v1.3.3-baseline.txt`).
 *   - **Pattern-agnostic strategy text.** The strategy paragraph
 *     references the canonical `sinon.stub` once but no sinon API
 *     names beyond that, so it transfers cleanly to OPA5 (AM6 — the
 *     `SAP_BUNDLED_SINON_CLAUSE` analogue for OPA5 stays deferred to
 *     V1.5+).
 *   - **AC4 — the "stub-then-pass" pattern from the V1.4 draft is
 *     technically wrong** for the cap_try shape: the controller's
 *     `sap.ui.define` triggers the unloadable module load at
 *     module-discovery time, BEFORE any `beforeEach` stub can apply.
 *     The viable pattern is pre-registering a stub module so karma's
 *     loader resolves it from cache.
 */

import type { ProjectGraph } from '../project/dependency-graph.js';
import { libNameFor } from '../project/lib-namespace.js';

export interface ProjectContextArgs {
  readonly projectGraph: ProjectGraph | undefined;
  readonly controllerRel: string;
}

/**
 * Returns the project-context block lines, or `[]` when the block
 * should be omitted (the graph is missing OR the controller has no
 * unpreloaded-lib intersection).
 *
 * Callers splice the result in with surrounding blank lines:
 * ```ts
 * const ctx = buildProjectContextLines(...);
 * if (ctx.length > 0) {
 *   lines.push('');
 *   lines.push(...ctx);
 *   lines.push('');
 * }
 * ```
 */
export function buildProjectContextLines(
  args: ProjectContextArgs,
): readonly string[] {
  const { projectGraph, controllerRel } = args;
  if (projectGraph === undefined) return [];

  const controller = projectGraph.controllers.find(
    (c) => c.controllerRel === controllerRel,
  );
  if (controller === undefined) return [];

  const gapLibs = new Set(projectGraph.unpreloadedLibs.map((g) => g.lib));
  const relevantLibs = controller.libNamespaces.filter((lib) => gapLibs.has(lib));
  if (relevantLibs.length === 0) return [];

  const moduleIdsByLib = new Map<string, string[]>();
  for (const moduleId of controller.imports) {
    const lib = libNameFor(moduleId);
    if (lib === null) continue;
    if (!relevantLibs.includes(lib)) continue;
    const existing = moduleIdsByLib.get(lib);
    if (existing === undefined) {
      moduleIdsByLib.set(lib, [moduleId]);
    } else if (!existing.includes(moduleId)) {
      existing.push(moduleId);
    }
  }

  const lines: string[] = [];
  lines.push('Project library context (karma-ui5 preload set):');
  lines.push(`  - Declared in manifest.json: ${listOrNone(projectGraph.manifestLibs)}`);
  lines.push(
    `  - karma.conf.js client.libs override: ${listOrNone(projectGraph.karmaClientLibs)}`,
  );
  lines.push('  - The controller TRANSITIVELY imports the following libs');
  lines.push("    that will NOT preload in karma-ui5's test runtime —");
  lines.push('    generating a test that loads the controller will hang at');
  lines.push("    karma's browserNoActivityTimeout (~30 seconds):");
  for (const lib of relevantLibs) {
    const ids = (moduleIdsByLib.get(lib) ?? []).map((id) => `"${id}"`).join(', ');
    lines.push(`      * ${lib} (via ${ids} in the controller's sap.ui.define array)`);
  }
  lines.push("  - Pre-registered stub strategy: BEFORE the test module's");
  lines.push('    main sap.ui.define, register a no-op stub for each');
  lines.push("    unloadable module so karma's loader resolves it from");
  lines.push('    cache:');
  lines.push('');
  const allOffendingModuleIds: string[] = [];
  for (const lib of relevantLibs) {
    for (const id of moduleIdsByLib.get(lib) ?? []) {
      if (!allOffendingModuleIds.includes(id)) allOffendingModuleIds.push(id);
    }
  }
  for (const id of allOffendingModuleIds) {
    lines.push(`      sap.ui.define("${id}", [], function () {`);
    lines.push('        return function StubModule() {};');
    lines.push('      });');
  }
  lines.push('');
  lines.push('      sap.ui.define([');
  lines.push(`        "${controllerModulePath(controllerRel)}",`);
  lines.push('        // ...any helper imports the test needs...');
  lines.push('      ], function (ControllerClass /*, helpers */) {');
  lines.push('        // test body');
  lines.push('      });');
  lines.push('');
  lines.push('    The stub is module-registry-only — controllers that import');
  lines.push('    the stub get a no-op constructor; if a controller method');
  lines.push('    USES the result of the unloadable module (e.g.,');
  lines.push('    constructing it then calling a method), additionally stub');
  lines.push('    the controller method at the instance level via sinon.stub.');

  return lines;
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)';
}

/**
 * `webapp/controller/Reports.controller.js` → `<project>/controller/Reports.controller`,
 * giving the LLM a concrete-looking AMD module path for the stub example
 * without committing to a specific project namespace (we leave the
 * `<project>` placeholder so the model substitutes its own).
 */
function controllerModulePath(controllerRel: string): string {
  const stripped = controllerRel
    .replace(/^webapp\//u, '')
    .replace(/\.js$/u, '');
  return `<project-namespace>/${stripped}`;
}
