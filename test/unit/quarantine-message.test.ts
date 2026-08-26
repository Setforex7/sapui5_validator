/**
 * V1.4-6 — snapshot-pinned witnesses for the four-case karma
 * module-load quarantine message.
 *
 * The {@link buildModuleLoadQuarantineMessage} helper discriminates
 * four shapes from `(failedModule, projectGraph)`:
 *
 *   - **Case A** — lib not in manifest, no `client.libs` override
 *     (cap_try-shape; the primary case V1.4-4's `--auto-apply-baseline-fixes`
 *     targets).
 *   - **Case B** — lib in manifest, no `client.libs` override; karma-ui5
 *     still failed (CDN coverage gap).
 *   - **Case C** — lib in `client.libs` override but not in manifest;
 *     karma-ui5 still failed (CDN coverage / version mismatch).
 *   - **Case D** — no extractable module ID OR graph + both flags true.
 *
 * Each case is pinned to its literal text below. Drift in any case is
 * an intentional edit (V1.4-6 plan invariant). The graceful-degradation
 * path (no graph → Case A unconditionally) and the lib-underivable
 * variant of Case A (1-segment module ID) are pinned in dedicated
 * cases at the bottom.
 */

import { describe, expect, test } from 'vitest';
import { buildModuleLoadQuarantineMessage } from '../../src/generation/retry-loop.js';
import type { ProjectGraph } from '../../src/project/dependency-graph.js';

const FAILED_MODULE = 'sap/ui/export/Spreadsheet';
const LIB = 'sap.ui.export';

function makeGraph(args: {
  readonly manifestLibs: readonly string[];
  readonly karmaClientLibs: readonly string[];
  readonly projectNamespace?: string | null;
}): ProjectGraph {
  return {
    controllers: [],
    manifestLibs: args.manifestLibs,
    karmaClientLibs: args.karmaClientLibs,
    alwaysAvailableLibs: ['sap.ui.core', 'sap.ui.thirdparty'],
    unpreloadedLibs: [],
    projectNamespace: args.projectNamespace ?? null,
  };
}

describe('buildModuleLoadQuarantineMessage — V1.4-6 four-case discrimination', () => {
  test('Case A — lib NOT in manifest, no client.libs → recommends --auto-apply-baseline-fixes + manual manifest entry', () => {
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [],
    });
    const msg = buildModuleLoadQuarantineMessage(FAILED_MODULE, graph);
    expect(msg).toMatchInlineSnapshot(
      `
      "karma could not load JavaScript module 'sap/ui/export/Spreadsheet' (required by the generated test). The library 'sap.ui.export' is not declared in webapp/manifest.json's sap.ui5.dependencies.libs section. Run \`sapui5-validate validate --auto-apply-baseline-fixes\` to add it automatically, or add this entry manually:
        "sap.ui.export": {}
      under sap.ui5.dependencies.libs in webapp/manifest.json. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."
    `,
    );
  });

  test('Case B — lib IN manifest, no client.libs → CDN-coverage hint + pre-registered stub fallback', () => {
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core', LIB],
      karmaClientLibs: [],
    });
    const msg = buildModuleLoadQuarantineMessage(FAILED_MODULE, graph);
    expect(msg).toMatchInlineSnapshot(
      `"karma could not load JavaScript module 'sap/ui/export/Spreadsheet' (required by the generated test). The library 'sap.ui.export' IS declared in webapp/manifest.json but failed to load from the configured UI5 CDN (see karma.conf.js \`ui5.url\` — sapui5.hana.ondemand.com vs sdk.openui5.org diverge on enterprise-only libraries). Check whether the CDN supports 'sap.ui.export' at the project's UI5 version. If the test environment cannot serve the library, set client.libs in karma.conf.js to override the preload set, or pre-register a stub for 'sap/ui/export/Spreadsheet' in the test via sap.ui.define("sap/ui/export/Spreadsheet", [], function () { ... }) before the test module's main sap.ui.define. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."`,
    );
  });

  test('Case C — lib NOT in manifest, IS in client.libs → CDN/karma-ui5 version hint + stub fallback', () => {
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [LIB],
    });
    const msg = buildModuleLoadQuarantineMessage(FAILED_MODULE, graph);
    expect(msg).toMatchInlineSnapshot(
      `"karma could not load JavaScript module 'sap/ui/export/Spreadsheet' (required by the generated test). The library 'sap.ui.export' is listed in karma.conf.js's client.libs override but failed to load anyway. The most likely cause is CDN coverage — the configured UI5 CDN (per karma.conf.js \`ui5.url\`) may not ship this library at the project's UI5 version — or a karma-ui5 version mismatch. Check the CDN URL in karma.conf.js (sapui5.hana.ondemand.com vs sdk.openui5.org diverge on enterprise-only libraries) and karma-ui5's documented preload behaviour for your installed version. If the test environment cannot serve the library, pre-register a stub for 'sap/ui/export/Spreadsheet' in the test via sap.ui.define("sap/ui/export/Spreadsheet", [], function () { ... }) before the test module's main sap.ui.define. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."`,
    );
  });

  test('Case D — failedModule is null → generic fallback that points at the audit log', () => {
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [],
    });
    const msg = buildModuleLoadQuarantineMessage(null, graph);
    expect(msg).toMatchInlineSnapshot(
      `"karma could not load a JavaScript module required by the generated test. The test page hung waiting for the module load and karma's browserNoActivityTimeout fired, but the karma output did not surface the specific module ID. Check the audit log at .sapui5-validator/last-run/verify/<callId>-karma.txt for the failed module name and the library that ships it; then either declare the library in webapp/manifest.json's sap.ui5.dependencies.libs section or pre-register a stub for the module in the test. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."`,
    );
  });

  test('Case D (graph both-flags-true variant) — lib in BOTH manifest AND client.libs → falls back to generic Case D', () => {
    // Structurally improbable in real projects (declaring the same lib
    // in both places is an explicit redundancy), but the discrimination
    // logic is deterministic: when both flags are true, Case D fires.
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core', LIB],
      karmaClientLibs: [LIB],
    });
    const msg = buildModuleLoadQuarantineMessage(FAILED_MODULE, graph);
    expect(msg).toMatchInlineSnapshot(
      `"karma could not load a JavaScript module required by the generated test. The test page hung waiting for the module load and karma's browserNoActivityTimeout fired, but the karma output did not surface the specific module ID. Check the audit log at .sapui5-validator/last-run/verify/<callId>-karma.txt for the failed module name and the library that ships it; then either declare the library in webapp/manifest.json's sap.ui5.dependencies.libs section or pre-register a stub for the module in the test. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."`,
    );
  });
});

describe('buildModuleLoadQuarantineMessage — V1.4-8 project-own-module guard', () => {
  test("failed module in the project's own namespace → own-module message, NOT a manifest/client.libs recommendation", () => {
    // cap_try Shop shape: the controller's own module fails to load
    // (CDN-timeout while resolving the in-project graph). `libNameFor`
    // derives `cap_try.controller`, which is project-local — the message
    // must not tell the user to add their own namespace anywhere.
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [],
      projectNamespace: 'cap_try',
    });
    const msg = buildModuleLoadQuarantineMessage(
      'cap_try/controller/Shop',
      graph,
    );
    expect(msg).toContain("module 'cap_try/controller/Shop'");
    expect(msg).toContain("project's own namespace");
    expect(msg).toMatch(/not.*missing third-party library/i);
    // Negative assertions: none of the lib-recommendation wording leaks.
    expect(msg).not.toContain('--auto-apply-baseline-fixes');
    expect(msg).not.toContain('sap.ui5.dependencies.libs');
    expect(msg).not.toContain('"cap_try.controller"');
  });

  test('project-local guard requires a known namespace — null namespace falls through to Case A', () => {
    // When the namespace is unknown, the guard cannot fire; the legacy
    // Case A path still applies (a regression here would silence the
    // own-module case unexpectedly).
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [],
      projectNamespace: null,
    });
    const msg = buildModuleLoadQuarantineMessage(
      'cap_try/controller/Shop',
      graph,
    );
    expect(msg).toContain('--auto-apply-baseline-fixes');
  });
});

describe('buildModuleLoadQuarantineMessage — graceful-degradation paths', () => {
  test('projectGraph undefined + derivable lib → falls back to Case A wording (legacy V1.3.3-5 path)', () => {
    // When the graph is missing (unit-test path or a future refactor
    // breaks threading), Case A fires unconditionally so the user still
    // sees a manifest-recommend hint rather than the generic Case D.
    const msg = buildModuleLoadQuarantineMessage(FAILED_MODULE, undefined);
    expect(msg).toMatchInlineSnapshot(
      `
      "karma could not load JavaScript module 'sap/ui/export/Spreadsheet' (required by the generated test). The library 'sap.ui.export' is not declared in webapp/manifest.json's sap.ui5.dependencies.libs section. Run \`sapui5-validate validate --auto-apply-baseline-fixes\` to add it automatically, or add this entry manually:
        "sap.ui.export": {}
      under sap.ui5.dependencies.libs in webapp/manifest.json. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."
    `,
    );
  });

  test('1-segment failedModule (lib underivable) + projectGraph supplied → Case A with lib-null wording', () => {
    // `libNameFor('Foo')` returns null (V1.3.3-5 AH4 — no parent
    // library derivable from a 1-segment module ID). The message
    // still names the module and points at the manifest fix.
    const graph = makeGraph({
      manifestLibs: ['sap.m', 'sap.ui.core'],
      karmaClientLibs: [],
    });
    const msg = buildModuleLoadQuarantineMessage('Foo', graph);
    expect(msg).toMatchInlineSnapshot(
      `"karma could not load JavaScript module 'Foo' (required by the generated test). The test page hung waiting for the module load and karma's browserNoActivityTimeout fired. The parent library of 'Foo' could not be derived from the module ID; add the library that ships 'Foo' to webapp/manifest.json's sap.ui5.dependencies.libs section, or re-run with --auto-apply-baseline-fixes once the manifest is corrected. The LLM cannot fix this from the test-file side; further refinement attempts would produce the same failure."`,
    );
  });
});
