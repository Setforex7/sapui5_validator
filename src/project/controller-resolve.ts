/**
 * COR-6 — layout-aware resolution of the controller a view declares.
 *
 * A view's `controllerName="<dotted>"` is the controller's fully-qualified UI5
 * module name: the project's `sap.app.id` namespace, then the path under
 * `webapp/` (dots → slashes), then the class name. Two checks need to map it
 * back to a `webapp/`-relative file path — `globals-in-views` (to embed the
 * paired controller in its prompt) and OPA5 discovery (to pair view+controller)
 * — and both had their own brittle heuristic:
 *
 *   - `globals-in-views` kept only the LAST segment → silently failed on any
 *     nested controller (`<ns>.controller.sub.Main`).
 *   - OPA5 sliced from the FIRST `controller` segment → misfired whenever a
 *     namespace segment was literally named `controller`.
 *
 * This shared resolver fixes both: it strips the known `sap.app.id` prefix when
 * it matches (the precise mapping, which tolerates a `controller`-in-namespace),
 * and otherwise falls back to the chain from the LAST `controller` segment
 * (handles nesting AND `controller`-in-namespace without a manifest). Every
 * candidate is gated on the file existing, so an unresolved name returns `null`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonWithBom } from '../util/json-read.js';

const CONTROLLER_NAME_RE = /\bcontrollerName\s*=\s*['"]([^'"]+)['"]/u;

/**
 * Resolve the `webapp/`-relative POSIX path of the controller named by a dotted
 * `controllerName`, or `null` when none of the layout-derived candidates exist
 * on disk.
 */
export function resolveControllerRelFromName(args: {
  readonly projectRoot: string;
  readonly controllerName: string;
}): string | null {
  const dotted = args.controllerName;
  const candidates: string[] = [];

  // 1. Precise: strip the project's own namespace prefix when it matches.
  const namespace = readProjectNamespace(args.projectRoot);
  if (namespace !== null && (dotted === namespace || dotted.startsWith(`${namespace}.`))) {
    const remainder = dotted.slice(namespace.length).replace(/^\./u, '');
    if (remainder.length > 0) candidates.push(remainder);
  }

  // 2. Fallback: the segment chain from the LAST `controller` segment. Strictly
  //    better than the first occurrence — it survives a `controller`-named
  //    namespace segment and preserves nested sub-folders.
  const segments = dotted.split('.');
  const lastControllerIx = segments.lastIndexOf('controller');
  if (lastControllerIx >= 0 && lastControllerIx < segments.length - 1) {
    candidates.push(segments.slice(lastControllerIx).join('.'));
  }

  for (const remainder of candidates) {
    const base = `webapp/${remainder.replace(/\./gu, '/')}.controller`;
    // V1.9 GA1-05 — dual-suffix resolution. A JS project's controller is
    // `.controller.js`; a TS project's is `.controller.ts`. Both are tried
    // existsSync-gated, `.js` first so a JS project resolves byte-identically
    // (the `.ts` candidate only ever matches when no `.js` exists).
    for (const suffix of CONTROLLER_SUFFIXES) {
      const rel = `${base}${suffix}`;
      if (existsSync(join(args.projectRoot, rel))) return rel;
    }
  }
  return null;
}

/** Controller file suffixes, JS first (the legacy path) then TS (V1.9 GA1-05). */
const CONTROLLER_SUFFIXES: readonly string[] = ['.js', '.ts'];

/**
 * Read a view's `controllerName` attribute and resolve it via
 * {@link resolveControllerRelFromName}. Returns `null` when the view declares
 * no controller or none of the candidates exist.
 */
export function resolveControllerRelFromView(args: {
  readonly projectRoot: string;
  readonly viewContent: string;
}): string | null {
  const dotted = CONTROLLER_NAME_RE.exec(args.viewContent)?.[1];
  if (dotted === undefined || dotted.length === 0) return null;
  return resolveControllerRelFromName({
    projectRoot: args.projectRoot,
    controllerName: dotted,
  });
}

/** Project's own namespace from `webapp/manifest.json`'s `sap.app.id`, or `null`. */
function readProjectNamespace(projectRoot: string): string | null {
  const p = join(projectRoot, 'webapp', 'manifest.json');
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = parseJsonWithBom(readFileSync(p, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sapApp = (parsed as Record<string, unknown>)['sap.app'];
    if (typeof sapApp !== 'object' || sapApp === null) return null;
    const id = (sapApp as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
