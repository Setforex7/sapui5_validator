/**
 * SPEC §2.2 — a directory is a SAPUI5 project if either:
 *   1. `ui5.yaml` exists at the project root, OR
 *   2. `webapp/manifest.json` exists AND has `sap.app.type === "application"`
 *      AND `webapp/Component.js` (or `.ts`) exists.
 *
 * Failure cases produce a structured result, never an exception. The CLI
 * surfaces the message and exits non-zero (SPEC §2.19).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonWithBom } from '../util/json-read.js';
import { globProjectFiles } from './glob-project.js';

export type DetectionVia = 'ui5.yaml' | 'manifest+component';

/**
 * V1.9 TS-DETECT (Phase 0) — the source language of a SAPUI5 project, used to
 * gate TS-aware discovery (GA1-01/04) and, from Phase 2 on, the verify-lane
 * selection. `'js'` is the byte-identical legacy path; `'ts'` widens discovery
 * to `.ts`/`.qunit.ts`. Detection is read-only and never throws.
 */
export type ProjectLanguage = 'js' | 'ts';

export type ProjectDetection =
  | { readonly ok: true; readonly via: DetectionVia }
  | { readonly ok: false; readonly message: string };

const manifestSchema = z
  .object({
    'sap.app': z
      .object({ type: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function detectSapUi5Project(projectRoot: string): ProjectDetection {
  if (existsSync(join(projectRoot, 'ui5.yaml'))) {
    return { ok: true, via: 'ui5.yaml' };
  }
  const manifestPath = join(projectRoot, 'webapp', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      message: `Not a SAPUI5 project at ${projectRoot}: no ui5.yaml and no webapp/manifest.json.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      message: `Failed to parse webapp/manifest.json: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const validated = manifestSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      message: `webapp/manifest.json failed schema validation: ${validated.error.message}`,
    };
  }
  const sapApp = validated.data['sap.app'];
  const sapAppType = sapApp?.type;
  if (sapAppType !== 'application') {
    const observed = sapAppType === undefined ? 'undefined' : JSON.stringify(sapAppType);
    return {
      ok: false,
      message: `webapp/manifest.json: sap.app.type must be "application" (got ${observed}).`,
    };
  }
  const componentJs = existsSync(join(projectRoot, 'webapp', 'Component.js'));
  const componentTs = existsSync(join(projectRoot, 'webapp', 'Component.ts'));
  if (!componentJs && !componentTs) {
    return {
      ok: false,
      message: `webapp/Component.js (or .ts) not found.`,
    };
  }
  return { ok: true, via: 'manifest+component' };
}

/**
 * Project-relative POSIX paths of the `.ts` SAPUI5 **sources** under `webapp/`
 * — the files a TS run would analyze. Ambient declaration files (`.d.ts`) and
 * anything under `node_modules/` are NOT sources and are excluded, so a JS
 * project that merely ships hand-written type declarations is not mistaken for
 * a TS project (this is the fix for the old guard's `types.d.ts` false-refusal,
 * AUDIT-v0.7.0). Read-only; degrades to `[]` on any enumeration error.
 */
export async function listWebappTsSources(projectRoot: string): Promise<string[]> {
  try {
    const files = await globProjectFiles(['webapp/**/*.ts'], {
      cwd: projectRoot,
      dot: false,
      absolute: false,
      onlyFiles: true,
      ignore: ['**/node_modules/**', 'webapp/**/*.d.ts'],
    });
    return [...files].sort();
  } catch {
    // Read-only contract: an enumeration failure must never throw out of
    // detection. Treat as "no TS sources observed" — the secondary signal
    // below still gets a chance, and the run defaults to the safe legacy path.
    return [];
  }
}

/**
 * V1.9 TS-VERIFY (Phase 2) — true iff the project ships its own `typescript`
 * (the `tsc` the static verify lane invokes for `tsc --noEmit`). Read-only,
 * filesystem-only: a project that has no `tsc` simply skips the tsc verify
 * step (ui5lint still type-checks the `.ts` internally), so this never throws
 * and never executes anything. The CLI itself takes **no** `typescript`
 * dependency — `tsc` is always the PROJECT's subprocess (diagnosis §3.1/DEP-3).
 */
export function hasProjectTypeScript(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, 'node_modules', 'typescript', 'package.json')) ||
    existsSync(join(projectRoot, 'node_modules', '.bin', 'tsc')) ||
    existsSync(join(projectRoot, 'node_modules', '.bin', 'tsc.cmd'))
  );
}

/** eslint config files scanned (as TEXT, never executed) for a TS-aware parser. */
const ESLINT_CONFIG_CANDIDATES: readonly string[] = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc',
];
/** Substrings whose presence indicates a `typescript-eslint` parser is wired. */
const TS_ESLINT_MARKERS: readonly string[] = ['typescript-eslint', '@typescript-eslint'];

/**
 * V1.9 G2-02/G2-03 (Phase 2) — true iff the project ships a TS-aware eslint
 * configuration (a `typescript-eslint` parser). A stock JS-only flat config
 * parse-errors on `.ts`, so eslint is widened to `.ts` ONLY when this holds;
 * otherwise `.ts` is skipped from the eslint step and ui5lint covers it
 * (diagnosis §2.8). Detection is a read-only TEXT scan of the project's
 * package.json and eslint config files — those configs are executable JS, so
 * we never `require()` them, only read their bytes. Never throws.
 */
export function hasTsAwareEslintConfig(projectRoot: string): boolean {
  const scan = (p: string): boolean => {
    try {
      if (!existsSync(p)) return false;
      const txt = readFileSync(p, 'utf8');
      return TS_ESLINT_MARKERS.some((m) => txt.includes(m));
    } catch {
      return false;
    }
  };
  // package.json (dependencies / devDependencies / inline eslintConfig).
  if (scan(join(projectRoot, 'package.json'))) return true;
  for (const name of ESLINT_CONFIG_CANDIDATES) {
    if (scan(join(projectRoot, name))) return true;
  }
  return false;
}

/**
 * V1.9 TS-DETECT (Phase 0) — classify a project as `'js'` or `'ts'`. Two
 * independent signals, OR'd; either is sufficient and neither can fire on a
 * pure-JS project:
 *   1. **Primary** — a non-declaration `.ts` source exists under `webapp/`
 *      ({@link listWebappTsSources}). This is the direct "is there TS to
 *      validate" test and covers every real TS-SAPUI5 app and the fixtures.
 *   2. **Corroborator** — a root `tsconfig.json` AND a `ui5-tooling-transpile`
 *      task referenced in `ui5.yaml`. A JS project has no transpile task, so
 *      this never mis-routes JS; it only adds robustness for the (degenerate)
 *      case where signal 1's enumeration was unavailable.
 *
 * Read-only and total: never throws, defaults to `'js'`. Erring toward `'ts'`
 * is the safe direction — a false `'ts'` routes to the Phase-0 honest refusal,
 * whereas a false `'js'` would silently under-scan a TS project (the HB-2 hole).
 */
export async function detectProjectLanguage(projectRoot: string): Promise<ProjectLanguage> {
  if ((await listWebappTsSources(projectRoot)).length > 0) return 'ts';
  if (existsSync(join(projectRoot, 'tsconfig.json')) && hasUi5TranspileTask(projectRoot)) {
    return 'ts';
  }
  return 'js';
}

/** True iff `ui5.yaml` references the `ui5-tooling-transpile` task (text scan, never executed). */
function hasUi5TranspileTask(projectRoot: string): boolean {
  const ui5Yaml = join(projectRoot, 'ui5.yaml');
  if (!existsSync(ui5Yaml)) return false;
  try {
    return readFileSync(ui5Yaml, 'utf8').includes('ui5-tooling-transpile');
  } catch {
    return false;
  }
}
