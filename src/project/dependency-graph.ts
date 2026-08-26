/**
 * V1.4-4 — implements the V1.4-3 stub. The `ProjectGraph` value type
 * captures the project's UI5 dependency state the V1.4
 * `baseline-unpreloaded-libs` check (`src/checks/unpreloaded-libs.ts`)
 * and the V1.4-5 prompt-enrichment paths consume to predict (and,
 * via the manifest auto-fix, prevent) the karma module-load failure
 * class V1.3.3-5 currently only diagnoses after-the-fact.
 *
 * Behaviour-boundary notes (V1.4-4):
 *   - **Conservative-by-design.** When any of the input artefacts
 *     (manifest.json, karma.conf.js, a controller file) is missing
 *     or unparseable, the graph degrades to an empty result for
 *     that surface — never throws, never blocks the orchestrator.
 *     A malformed manifest yields `manifestLibs: []`; an unreadable
 *     controller yields a `ControllerImports` entry with
 *     `imports: []` so the surrounding controller list still
 *     reflects the discovered file set.
 *
 *   - **Manifest-driven karma-ui5 default.** karma-ui5's preload
 *     set is **manifest-driven by default** — it reads
 *     `sap.ui5.dependencies.libs` from the project's manifest and
 *     adds those libs to the preload set. The gap computation
 *     therefore unions `manifestLibs`, the `client.libs` override
 *     (when set in karma.conf.js), and the
 *     `KARMA_UI5_ALWAYS_AVAILABLE` constant; any controller-import
 *     namespace OUTSIDE that union is a predicted gap.
 *
 *   - **One source of truth for namespace derivation.** The
 *     `libNamespaces` field is derived via the shared
 *     `src/project/lib-namespace.ts` helper (V1.4-4 AP2), which is
 *     also imported by `src/verify/karma.ts`'s V1.3.3-5 classifier
 *     short-circuit. Both consumers stay in lock-step; AH4's
 *     3-segment cap behaviour is the contract.
 *
 *   - **Schema additivity.** `ProjectGraph` is a brand-new value
 *     type; no existing report.json field is renamed, no union
 *     narrowed. `RunReport.schemaVersion: 2` stays.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { globProjectFiles } from './glob-project.js';
import type { ProjectLanguage } from './detect.js';
import { parseControllerImports, parseEsModuleImports } from './controller-imports.js';
import {
  KARMA_UI5_ALWAYS_AVAILABLE,
  isCoreBundledNamespace,
} from './karma-ui5-defaults.js';
import { libNameFor } from './lib-namespace.js';
import { probeLibServed } from './cdn-probe.js';
import { parseJsonWithBom } from '../util/json-read.js';
import {
  parseKarmaClientLibs,
  parseKarmaUi5Url,
  type TestLayout,
} from './test-layout.js';

/**
 * One controller's `sap.ui.define` import array, plus the derived
 * library namespaces. `libNamespaces` is the 3-segment cap shared
 * with V1.3.3-5 `libNameFor` (V1.4-4 AP2 — both consumers import the
 * helper from `src/project/lib-namespace.ts`).
 */
export interface ControllerImports {
  readonly controllerRel: string;
  readonly imports: readonly string[];
  readonly libNamespaces: readonly string[];
}

/**
 * One predicted gap. `importedBy` is the list of controller paths
 * (project-root-relative, in document order) whose imports
 * transitively pull the lib in but whose project state does not
 * declare it.
 *
 * `cdnServed` (V1.4-10) records whether the configured karma-ui5 CDN
 * (`ui5.url` in karma.conf.js) actually serves the library:
 *   - `true`  → preload-fixable: declaring the lib in `manifest.json`
 *     lets karma-ui5 preload it (the `suggestedFix: 'manifest'` path).
 *   - `false` → stub-only: the lib 404s on the configured CDN, so a
 *     manifest declaration would NOT help; the generated test must
 *     pre-register a stub instead. The auto-fix omits these libs.
 * Defaults to `true` when no probe runs (no `ui5.url`, no transport, or
 * a network error) — the conservative default preserving pre-V1.4-10
 * behaviour.
 */
export interface UnpreloadedLib {
  readonly lib: string;
  readonly importedBy: readonly string[];
  readonly suggestedFix: 'manifest';
  readonly cdnServed: boolean;
  /**
   * R2.4 (AUDIT §5.5) — whether a CDN probe ACTUALLY answered for this lib.
   * `false` means `cdnServed: true` is only the conservative default (no
   * `ui5.url` configured, no transport, or the probe threw), NOT a verified
   * fact. `checkUnpreloadedLibs` uses this to refuse `--auto-apply-baseline-
   * fixes` manifest writes for heuristic-derived namespaces that nothing real
   * (neither the known-library table nor a probe) ever confirmed — the
   * offline phantom-write path that hangs karma.
   */
  readonly cdnProbed: boolean;
}

/**
 * Whole-project graph. All array fields are readonly. Conservative
 * defaults: empty when the source artefact is missing or unparseable.
 *
 * - `manifestLibs` — keys of `sap.ui5.dependencies.libs` from
 *   `webapp/manifest.json`.
 * - `karmaClientLibs` — quoted strings from karma.conf.js's
 *   `client: { libs: [...] }` override (empty when absent — the
 *   karma-ui5 default IS the manifest set; see V1.4-4 note).
 * - `alwaysAvailableLibs` — `KARMA_UI5_ALWAYS_AVAILABLE` from
 *   `src/project/karma-ui5-defaults.ts`.
 * - `unpreloadedLibs` — computed gap:
 *   `(controllers[*].libNamespaces) MINUS
 *   (manifestLibs ∪ karmaClientLibs ∪ alwaysAvailableLibs)`.
 * - `projectNamespace` — the project's own namespace from
 *   `webapp/manifest.json`'s `sap.app.id` (e.g. `cap_try`), or `null`
 *   when the manifest is missing / the field is unreadable. Used by
 *   the gap computation to exclude intra-project imports AND (V1.4-8)
 *   by the reactive quarantine-message builder
 *   (`src/generation/retry-loop.ts`) to tell an own-module load
 *   failure apart from a genuine unpreloaded-lib failure.
 */
export interface ProjectGraph {
  readonly controllers: readonly ControllerImports[];
  readonly manifestLibs: readonly string[];
  readonly karmaClientLibs: readonly string[];
  readonly alwaysAvailableLibs: readonly string[];
  readonly unpreloadedLibs: readonly UnpreloadedLib[];
  readonly projectNamespace: string | null;
}

export interface BuildProjectGraphArgs {
  readonly projectRoot: string;
  readonly testLayout: TestLayout;
  /**
   * V1.4-10 — injectable CDN-availability probe (one call per gap lib).
   * Production omits it: the builder probes the karma `ui5.url` via
   * {@link probeLibServed}. Unit tests inject a deterministic fake (or
   * omit it, in which case fixtures without a `ui5.url` skip probing and
   * every gap defaults to `cdnServed: true`). Best-effort: a throwing
   * probe is treated as `true` (served).
   */
  readonly probeLib?: (lib: string) => Promise<boolean>;
  /**
   * V1.9 GA1-04 — source language gate. Defaults to `'js'` (the byte-identical
   * legacy controller glob); `'ts'` enumerates `.ts` controllers so the
   * dependency-graph / unpreloaded-libs spine is no longer inert for TS.
   */
  readonly projectLanguage?: ProjectLanguage;
}

const CONTROLLER_GLOB_JS: readonly string[] = ['webapp/**/*.js'];
const CONTROLLER_EXCLUDE_JS: readonly string[] = [
  'webapp/test/**',
  'webapp/Component.js',
  'webapp/Component.ts',
];
// V1.9 GA1-04 — TS controller enumeration: `.ts` sources minus ambient `.d.ts`
// declarations and the Component.ts entrypoint (mirror of the JS lists).
const CONTROLLER_GLOB_TS: readonly string[] = ['webapp/**/*.ts'];
const CONTROLLER_EXCLUDE_TS: readonly string[] = [
  'webapp/test/**',
  'webapp/Component.ts',
  'webapp/**/*.d.ts',
];

export async function buildProjectGraph(
  args: BuildProjectGraphArgs,
): Promise<ProjectGraph> {
  const { projectRoot, testLayout } = args;

  const manifestLibs = readManifestLibs(projectRoot);
  const karmaClientLibs = readKarmaClientLibs(testLayout);
  const karmaUi5Url = readKarmaUi5Url(testLayout);
  const alwaysAvailableLibs = KARMA_UI5_ALWAYS_AVAILABLE;
  // V1.4-10 — resolve the CDN-availability probe. Injected fake wins (unit
  // tests); otherwise probe the configured karma ui5.url; with no url there
  // is nothing to probe, so every gap defaults to cdnServed: true.
  const probe: ((lib: string) => Promise<boolean>) | null =
    args.probeLib ??
    (karmaUi5Url !== null ? (lib) => probeLibServed(karmaUi5Url, lib) : null);
  // The project's own namespace (from manifest `sap.app.id`) names modules
  // resolved via the loader's `paths` mapping — those imports never go
  // through the karma-ui5 lib-preload pipeline, so a `cap_try/controller/...`
  // import must not appear in `unpreloadedLibs`.
  const projectNamespace = readProjectNamespace(projectRoot);

  const language: ProjectLanguage = args.projectLanguage ?? 'js';
  const controllerGlob = language === 'ts' ? CONTROLLER_GLOB_TS : CONTROLLER_GLOB_JS;
  const controllerExclude = language === 'ts' ? CONTROLLER_EXCLUDE_TS : CONTROLLER_EXCLUDE_JS;
  const controllerAbsPaths = await globProjectFiles([...controllerGlob], {
    cwd: projectRoot,
    ignore: [...controllerExclude],
    absolute: true,
    onlyFiles: true,
  });
  controllerAbsPaths.sort();

  const controllers: ControllerImports[] = [];
  for (const abs of controllerAbsPaths) {
    const controllerRel = toPosix(relative(projectRoot, abs));
    let content = '';
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      // unreadable; treat as empty (degrades to imports: [])
    }
    // V1.9 GA1-03 — route by source language. TS controllers have no
    // `sap.ui.define([...])` head; their ES-module imports drive the SAME
    // `libNamespaces`/unpreloaded-libs spine. JS controllers keep the
    // `sap.ui.define` parser (byte-identical legacy path).
    const imports =
      language === 'ts' ? parseEsModuleImports(content) : parseControllerImports(content);
    const libNamespaces = dedupePreserveOrder(
      imports
        .map((id) => libNameFor(id))
        .filter((s): s is string => s !== null),
    );
    controllers.push({
      controllerRel,
      imports,
      libNamespaces,
    });
  }

  // V1.4-9 / V1.9.1-D3 — core-bundled namespaces (`sap/ui/model`, `sap/base`,
  // `sap/ui/base`, `sap/ui/Device` …) are derived by `libNameFor` as if they
  // were libraries but actually ship inside the always-preloaded `sap.ui.core`
  // bundle, so they must never count as gaps. The exclusion moved from the flat
  // `known` set to the prefix-aware `isCoreBundledNamespace` (V1.9.1-D3):
  // exact membership missed dotted descendants the 3-segment cap over-shoots to
  // (`sap.base.i18n`, `sap.base.strings`), which surfaced as false-positive gaps
  // on a real TS project. `sap.ui` stays exact-only inside the helper, so real
  // `sap.ui.*` libraries (`sap.ui.table`, `sap.ui.export`, …) remain flaggable.
  const known = new Set<string>([
    ...manifestLibs,
    ...karmaClientLibs,
    ...alwaysAvailableLibs,
  ]);
  const gapMap = new Map<string, string[]>();
  for (const c of controllers) {
    for (const lib of c.libNamespaces) {
      if (known.has(lib) || isCoreBundledNamespace(lib)) continue;
      if (isProjectLocal(lib, projectNamespace)) continue;
      const existing = gapMap.get(lib);
      if (existing === undefined) {
        gapMap.set(lib, [c.controllerRel]);
      } else if (!existing.includes(c.controllerRel)) {
        existing.push(c.controllerRel);
      }
    }
  }
  const unpreloadedLibs: UnpreloadedLib[] = [];
  for (const [lib, importedBy] of gapMap.entries()) {
    // Best-effort: a throwing/missing probe resolves to `true` (served),
    // so a network failure never wrongly forces the stub path. R2.4 —
    // `cdnProbed` records whether the probe genuinely answered: a thrown
    // probe keeps the conservative `cdnServed: true` but is NOT a
    // confirmation, so it counts as un-probed for the auto-apply guard.
    let cdnServed = true;
    let cdnProbed = false;
    if (probe !== null) {
      try {
        cdnServed = await probe(lib);
        cdnProbed = true;
      } catch {
        cdnServed = true;
        cdnProbed = false;
      }
    }
    unpreloadedLibs.push({
      lib,
      importedBy: [...importedBy],
      suggestedFix: 'manifest',
      cdnServed,
      cdnProbed,
    });
  }

  return {
    controllers,
    manifestLibs,
    karmaClientLibs,
    alwaysAvailableLibs,
    unpreloadedLibs,
    projectNamespace,
  };
}

/**
 * Read `sap.ui5.dependencies.libs` keys from `webapp/manifest.json`.
 * Tolerant of missing file / malformed JSON / missing nested field —
 * returns `[]` in every degraded shape.
 */
function readManifestLibs(projectRoot: string): readonly string[] {
  const p = join(projectRoot, 'webapp', 'manifest.json');
  if (!existsSync(p)) return [];
  try {
    const content = readFileSync(p, 'utf8');
    const parsed: unknown = parseJsonWithBom(content);
    const libs = readLibsFromManifest(parsed);
    return libs;
  } catch {
    return [];
  }
}

/**
 * Read the project's own namespace from `webapp/manifest.json`'s
 * `sap.app.id`. Returns `null` when the manifest is missing or the field
 * cannot be read. Used to exclude intra-project imports
 * (`<namespace>/foo/bar`) from the unpreloaded-libs gap.
 */
function readProjectNamespace(projectRoot: string): string | null {
  const p = join(projectRoot, 'webapp', 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    const content = readFileSync(p, 'utf8');
    const parsed: unknown = parseJsonWithBom(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sapApp = (parsed as Record<string, unknown>)['sap.app'];
    if (typeof sapApp !== 'object' || sapApp === null) return null;
    const id = (sapApp as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * True when `lib` is the project's own namespace or a sub-namespace of
 * it (e.g. `cap_try` or `cap_try.controller` for project `cap_try`).
 * Such names resolve through the loader's `paths` mapping, not the
 * karma-ui5 lib-preload pipeline, so they must never be treated as an
 * unpreloaded library. Exported (V1.4-8) so the reactive
 * quarantine-message builder shares this one definition with the
 * proactive gap computation rather than re-deriving it. Returns `false`
 * when the namespace is unknown (`null`).
 */
export function isProjectLocal(
  lib: string,
  projectNamespace: string | null,
): boolean {
  if (projectNamespace === null) return false;
  return lib === projectNamespace || lib.startsWith(`${projectNamespace}.`);
}

function readLibsFromManifest(parsed: unknown): readonly string[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const sapui5 = (parsed as Record<string, unknown>)['sap.ui5'];
  if (typeof sapui5 !== 'object' || sapui5 === null) return [];
  const deps = (sapui5 as Record<string, unknown>)['dependencies'];
  if (typeof deps !== 'object' || deps === null) return [];
  const libs = (deps as Record<string, unknown>)['libs'];
  if (typeof libs !== 'object' || libs === null) return [];
  return Object.keys(libs as Record<string, unknown>);
}

function readKarmaClientLibs(testLayout: TestLayout): readonly string[] {
  const karmaPath = testLayout.karma?.path;
  if (karmaPath === undefined) return [];
  if (!existsSync(karmaPath)) return [];
  try {
    const content = readFileSync(karmaPath, 'utf8');
    return parseKarmaClientLibs(content);
  } catch {
    return [];
  }
}

/** V1.4-10 — read the karma-ui5 `ui5.url` (the CDN to probe). `null` when
 * absent or unreadable. */
function readKarmaUi5Url(testLayout: TestLayout): string | null {
  const karmaPath = testLayout.karma?.path;
  if (karmaPath === undefined) return null;
  if (!existsSync(karmaPath)) return null;
  try {
    return parseKarmaUi5Url(readFileSync(karmaPath, 'utf8'));
  } catch {
    return null;
  }
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

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
