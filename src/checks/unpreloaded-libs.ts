/**
 * V1.4-4 — deterministic baseline check (NO LLM) that detects
 * controllers whose `sap.ui.define` imports a UI5 library namespace
 * NOT declared in `webapp/manifest.json`'s
 * `sap.ui5.dependencies.libs` AND NOT overridden via karma.conf.js's
 * `client.libs`. The check consumes the V1.4-4 `ProjectGraph` and
 * emits one finding per `UnpreloadedLib` with a `proposedFix` that
 * patches the manifest.
 *
 * Not registered in `src/checks/index.ts` — the registry there is
 * for SPEC §2.8 LLM-driven semantic checks. Baseline checks
 * (`baseline-ui5lint`, `baseline-eslint`, `baseline-karma`,
 * `baseline-unpreloaded-libs`) are invoked directly by the
 * orchestrator (`src/commands/generate.ts`,
 * `src/commands/validate.ts`).
 *
 * Behaviour-boundary notes (V1.4-4):
 *   - **AM2 — alphabetised libs.** `buildPatchedManifest`
 *     re-alphabetises the entire `sap.ui5.dependencies.libs` object
 *     on every fix (not just the new key) so the manifest converges
 *     to a stable key order across multiple runs and the diff stays
 *     minimal after the first auto-fix lands.
 *   - **AM3 — absent intermediate objects.** If
 *     `sap.ui5.dependencies.libs` is absent the function CREATES
 *     the missing nested objects. If `sap.ui5` itself is absent the
 *     manifest is malformed beyond the auto-fix scope; the
 *     `proposedFix` is `null` and the finding is surfaced as
 *     manual-only.
 *   - **Indent + trailing-newline preserved.** The patched manifest
 *     is serialised with the same indent detected from the original
 *     file (defaults to 2 spaces). A trailing newline is preserved
 *     iff the original had one. This keeps the auto-fix diff
 *     focused on the actual semantic change.
 *   - **Deterministic — no LLM.** Unlike the seven SPEC §2.8 checks,
 *     this check never invokes Claude. The fix is computed
 *     mechanically from the manifest JSON and the gap; the
 *     orchestrator applies it directly when
 *     `--auto-apply-baseline-fixes` is set.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProjectGraph,
  UnpreloadedLib,
} from '../project/dependency-graph.js';
import { KNOWN_SAP_UI5_LIBRARIES } from '../project/lib-namespace.js';
import type { Finding } from '../types.js';
import { parseJsonWithBom } from '../util/json-read.js';

export interface CheckUnpreloadedLibsArgs {
  readonly projectRoot: string;
  readonly projectGraph: ProjectGraph;
}

export interface CheckUnpreloadedLibsResult {
  readonly findings: readonly Finding[];
}

export function checkUnpreloadedLibs(
  args: CheckUnpreloadedLibsArgs,
): CheckUnpreloadedLibsResult {
  if (args.projectGraph.unpreloadedLibs.length === 0) {
    return { findings: [] };
  }
  const manifestPath = join(args.projectRoot, 'webapp', 'manifest.json');
  const rawManifest = readManifestRaw(manifestPath);

  // V1.4-10 — only CDN-served (preload-fixable) gaps go into the manifest
  // patch. A stub-only gap (the lib 404s on the karma ui5.url CDN) is NOT
  // declared in the manifest — doing so would make karma-ui5 hang trying
  // to preload a module the CDN cannot serve. Stub-only gaps surface as
  // manual findings; the generated test pre-registers a stub for them
  // (driven by the prompt-context block in src/generation/prompt-context.ts).
  // R2.4 (AUDIT §5.5) — unverified heuristic namespaces are excluded too:
  // when no probe confirmed the lib AND it is not in the known-library
  // table, nothing real says the namespace exists, so writing it to the
  // manifest under --auto-apply-baseline-fixes could declare a phantom
  // (karma-ui5 preloads a 404 and hangs at browserNoActivityTimeout).
  const manifestGapLibs = args.projectGraph.unpreloadedLibs
    .filter((g) => g.cdnServed && !isUnverifiedHeuristicNamespace(g))
    .map((g) => g.lib);
  // V1.4-4 (AM2) — combine the manifest-fixable gaps into a single patched
  // manifest so the proposedFix on every such finding writes the same
  // converged file (one auto-apply write, no partial states).
  const combinedPatch =
    rawManifest !== null && manifestGapLibs.length > 0
      ? buildPatchedManifest(rawManifest, manifestGapLibs)
      : null;

  const findings: Finding[] = [];
  for (const gap of args.projectGraph.unpreloadedLibs) {
    if (!gap.cdnServed) {
      // V1.4-10 — stub-only gap: no manifest fix can help.
      findings.push({
        checkId: 'baseline-unpreloaded-libs',
        source: 'baseline',
        file: 'webapp/manifest.json',
        message: buildStubOnlyMessage(gap),
        proposedFix: null,
        explanation:
          `'${gap.lib}' is imported by ${gap.importedBy.join(', ')} but is ` +
          `not served by the karma test CDN (ui5.url in karma.conf.js) — the ` +
          `library-preload resource returns 404. Declaring it in ` +
          `webapp/manifest.json would NOT fix the test: karma-ui5 would still ` +
          `fail to preload it and hang at browserNoActivityTimeout. The ` +
          `generated test pre-registers a no-op stub for the module instead. ` +
          `Alternatively, point karma's ui5.url at a CDN that serves ` +
          `'${gap.lib}' (e.g. the SAPUI5 CDN for SAPUI5-only libraries), or ` +
          `add it to client.libs in karma.conf.js.`,
      });
      continue;
    }
    if (isUnverifiedHeuristicNamespace(gap)) {
      // R2.4 — refuse the auto-fix: the namespace came from the import
      // heuristic, is not in the known-library table, and no CDN probe ran
      // to confirm it. `proposedFix: null` keeps it out of BOTH commands'
      // --auto-apply-baseline-fixes write paths (they only write proposed
      // fixes), so the prevention layer cannot itself write a karma-hanging
      // phantom entry.
      findings.push({
        checkId: 'baseline-unpreloaded-libs',
        source: 'baseline',
        file: 'webapp/manifest.json',
        message: buildUnverifiedNamespaceMessage(gap),
        proposedFix: null,
        explanation:
          `The namespace '${gap.lib}' was derived heuristically from the ` +
          `imports of ${gap.importedBy.join(', ')}; it is not in the ` +
          `validator's known-library table and no CDN probe ran to confirm ` +
          `it exists (karma.conf.js has no reachable ui5.url). Auto-writing ` +
          `an unverified namespace to webapp/manifest.json risks declaring a ` +
          `phantom library — karma-ui5 would preload a 404 and hang at ` +
          `browserNoActivityTimeout. Configure a reachable ui5.url so the ` +
          `probe can verify '${gap.lib}', or declare the library in the ` +
          `manifest by hand if you know it is real.`,
      });
      continue;
    }
    const message = buildUnpreloadedLibMessage(gap);
    if (combinedPatch === null) {
      findings.push({
        checkId: 'baseline-unpreloaded-libs',
        source: 'baseline',
        file: 'webapp/manifest.json',
        message,
        proposedFix: null,
        explanation:
          `webapp/manifest.json is missing the 'sap.ui5' section, so the ` +
          `auto-fix cannot insert 'sap.ui5.dependencies.libs.${gap.lib}'. ` +
          `Add the section by hand or scaffold the manifest before re-running.`,
      });
      continue;
    }
    findings.push({
      checkId: 'baseline-unpreloaded-libs',
      source: 'baseline',
      file: 'webapp/manifest.json',
      message,
      proposedFix: { newFileContent: combinedPatch },
    });
  }
  return { findings };
}

/**
 * R2.4 (AUDIT §5.5) — true when nothing real ever confirmed this namespace:
 * `cdnServed` is only the no-probe default (`cdnProbed: false`) AND the
 * namespace is not in {@link KNOWN_SAP_UI5_LIBRARIES}. Such a gap is
 * heuristic-derived all the way down — it must surface as a manual finding,
 * never as an auto-applicable manifest patch.
 */
function isUnverifiedHeuristicNamespace(gap: UnpreloadedLib): boolean {
  return !gap.cdnProbed && !KNOWN_SAP_UI5_LIBRARIES.includes(gap.lib);
}

/**
 * R2.4 — message for a refused (unverified heuristic) namespace. The
 * actionable detail lives in the finding's `explanation`.
 */
function buildUnverifiedNamespaceMessage(gap: UnpreloadedLib): string {
  const usedBy = gap.importedBy.join(', ');
  return (
    `Controller import suggests UI5 library '${gap.lib}' (used by ${usedBy}), ` +
    `which is not declared in webapp/manifest.json — but the namespace is ` +
    `heuristic-derived and no CDN probe could confirm it exists, so the ` +
    `auto-fix is refused. Verify the library name and declare it manually, ` +
    `or configure karma's ui5.url so the validator can probe it.`
  );
}

/**
 * V1.4-10 — message for a stub-only gap (lib 404s on the karma CDN). The
 * actionable detail lives in the finding's `explanation`; this one-liner
 * states the situation for the status output.
 */
function buildStubOnlyMessage(gap: UnpreloadedLib): string {
  const usedBy = gap.importedBy.join(', ');
  return (
    `Controller import requires UI5 library '${gap.lib}' (used by ${usedBy}), ` +
    `which is NOT served by the configured karma test CDN (ui5.url). A ` +
    `manifest declaration cannot fix this; the generated test pre-registers ` +
    `a no-op stub for the module instead.`
  );
}

function buildUnpreloadedLibMessage(gap: UnpreloadedLib): string {
  const usedBy = gap.importedBy.join(', ');
  return (
    `Controller import requires UI5 library '${gap.lib}' (used by ${usedBy}), ` +
    `but it is not declared in webapp/manifest.json's ` +
    `sap.ui5.dependencies.libs section. karma-ui5 preloads only ` +
    `manifest-declared libs by default, so any test that loads an affected ` +
    `controller will hang at karma's browserNoActivityTimeout. ` +
    `Re-run with --auto-apply-baseline-fixes to add the declaration ` +
    `automatically.`
  );
}

function readManifestRaw(manifestPath: string): string | null {
  if (!existsSync(manifestPath)) return null;
  try {
    return readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pure function: given the raw manifest JSON and the list of library
 * namespaces to declare, return the patched manifest content. Returns
 * `null` when the manifest is unparseable or the `sap.ui5` section is
 * absent (AM3 — surface as manual-only).
 */
export function buildPatchedManifest(
  rawJson: string,
  libNames: readonly string[],
): string | null {
  if (rawJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const sapUi5 = root['sap.ui5'];
  // AM3 — when sap.ui5 is absent entirely, return null (manual-only finding).
  if (sapUi5 === undefined) return null;
  if (typeof sapUi5 !== 'object' || sapUi5 === null) return null;

  const sapUi5Obj = sapUi5 as Record<string, unknown>;
  let deps = sapUi5Obj['dependencies'];
  if (deps === undefined) {
    deps = {};
    sapUi5Obj['dependencies'] = deps;
  }
  if (typeof deps !== 'object' || deps === null) return null;

  const depsObj = deps as Record<string, unknown>;
  let libs = depsObj['libs'];
  if (libs === undefined) {
    libs = {};
    depsObj['libs'] = libs;
  }
  if (typeof libs !== 'object' || libs === null) return null;

  const libsObj = libs as Record<string, unknown>;
  for (const libName of libNames) {
    if (!(libName in libsObj)) {
      libsObj[libName] = {};
    }
  }
  // AM2 — alphabetise the entire libs object on every fix so the
  // manifest converges across multiple runs.
  const sortedLibs = Object.fromEntries(
    Object.entries(libsObj).sort(([a], [b]) => a.localeCompare(b)),
  );
  depsObj['libs'] = sortedLibs;

  const indent = detectIndent(rawJson);
  const serialised = JSON.stringify(root, null, indent);
  return rawJson.endsWith('\n') ? `${serialised}\n` : serialised;
}

/**
 * Detect the JSON indent from the first non-root key's leading
 * whitespace. Falls back to 2 spaces when the original is single-line
 * or uses tabs (we serialise with spaces for portability).
 */
function detectIndent(rawJson: string): number {
  const m = /\n([ ]+)\S/.exec(rawJson);
  if (m === null) return 2;
  const ws = m[1] ?? '';
  return ws.length > 0 ? ws.length : 2;
}
