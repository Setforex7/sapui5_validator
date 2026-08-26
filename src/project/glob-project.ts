/**
 * SEC-1 (V1.8) — one safe entry point for every `fast-glob` enumeration of a
 * SAPUI5 project's files.
 *
 * The audit (V1.8-DIAGNOSIS §1, MEDIUM) reproduced a denial-of-service: the
 * project globs ran with fast-glob's default `deep: Infinity` and
 * `followSymbolicLinks: true`, so a directory junction / symlink under
 * `webapp/` that points back to an ancestor made the walk expand without
 * terminating (92,760 paths from ~10 real files, never finished). It was
 * reached at `checkTsGuard` — the very first traversal — before the clean-tree
 * gate and with no `--force`.
 *
 * Two defenses, both applied here so no call site can forget one:
 *   1. **`followSymbolicLinks: false` (non-overridable).** A directory junction
 *      is reported as a symbolic link by `lstat` on every platform (Node maps
 *      Windows reparse points to `isSymbolicLink()`), so fast-glob never
 *      descends into it and the cycle terminates at its root. This is the
 *      primary fix — it stops the unbounded walk.
 *   2. **A hard file-count cap.** A loud, named abort if a single enumeration
 *      exceeds {@link MAX_PROJECT_FILES} — defense-in-depth for any other path
 *      explosion (a pathologically large tree, a future regression that
 *      re-enables link following). It ABORTS, never silently truncates
 *      discovery (a truncated scope would skip real files and miss findings).
 *
 * The runner is injectable so the unit suite can pin both behaviours
 * deterministically (repo convention — see `execImpl` / `fetchImpl` seams).
 */

import fg from 'fast-glob';

/**
 * Hard ceiling on the number of paths a single project enumeration may return.
 * Sized far above any real SAPUI5 webapp tree (hundreds to low-thousands of
 * in-scope files) and far below the runaway the audit observed, so a legitimate
 * project never trips it but a link cycle that slipped past defense (1) does.
 * A named constant per CLAUDE.md (no hard-coded caps).
 */
export const MAX_PROJECT_FILES = 50_000;

/**
 * Thrown when a project enumeration exceeds {@link MAX_PROJECT_FILES}. A loud,
 * named refusal — never a silent truncation (R2.2 discipline: a quietly
 * truncated file set would skip real files and under-report findings, the
 * opposite of fail-closed).
 */
export class ProjectFileLimitError extends Error {
  readonly limit: number;
  readonly count: number;
  readonly patterns: readonly string[];

  constructor(args: {
    readonly limit: number;
    readonly count: number;
    readonly patterns: readonly string[];
  }) {
    super(
      `Refusing to continue: project file enumeration returned more than the ` +
        `${args.limit}-file safety cap (patterns: ${args.patterns.join(', ')}). ` +
        `This usually means a symbolic link or directory junction under webapp/ ` +
        `forms a cycle. Remove the offending link and re-run.`,
    );
    this.name = 'ProjectFileLimitError';
    this.limit = args.limit;
    this.count = args.count;
    this.patterns = [...args.patterns];
    Object.setPrototypeOf(this, ProjectFileLimitError.prototype);
  }
}

/** The subset of fast-glob options the project enumerations use. */
export interface ProjectGlobOptions {
  readonly cwd: string;
  readonly ignore?: readonly string[];
  readonly absolute?: boolean;
  readonly onlyFiles?: boolean;
  readonly dot?: boolean;
}

/**
 * The concrete fast-glob options object {@link globProjectFiles} builds.
 * `followSymbolicLinks` is pinned to `false` and typed as such so the test
 * seam can assert it and a regression that re-enables link following fails to
 * typecheck against the runner contract.
 */
export interface ProjectGlobFgOptions {
  cwd: string;
  ignore?: string[];
  absolute?: boolean;
  onlyFiles?: boolean;
  dot?: boolean;
  followSymbolicLinks: false;
}

/** Injectable fast-glob runner (production uses the real binding). */
export type FgRunner = (
  patterns: string[],
  options: ProjectGlobFgOptions,
) => Promise<string[]>;

const defaultFg: FgRunner = (patterns, options) => fg(patterns, options);

/**
 * Enumerate project files safely: never follows symlinks/junctions, and aborts
 * loudly past {@link MAX_PROJECT_FILES}. The single fast-glob entry point for
 * every project-file glob in the runtime path.
 */
export async function globProjectFiles(
  patterns: readonly string[],
  options: ProjectGlobOptions,
  seam: { readonly fgImpl?: FgRunner; readonly limit?: number } = {},
): Promise<string[]> {
  const run = seam.fgImpl ?? defaultFg;
  const limit = seam.limit ?? MAX_PROJECT_FILES;
  const fgOptions: ProjectGlobFgOptions = {
    cwd: options.cwd,
    // SEC-1 defense (1): pinned, non-overridable — terminates link cycles.
    followSymbolicLinks: false,
    ...(options.ignore !== undefined ? { ignore: [...options.ignore] } : {}),
    ...(options.absolute !== undefined ? { absolute: options.absolute } : {}),
    ...(options.onlyFiles !== undefined ? { onlyFiles: options.onlyFiles } : {}),
    ...(options.dot !== undefined ? { dot: options.dot } : {}),
  };
  const matches = await run([...patterns], fgOptions);
  // SEC-1 defense (2): loud abort, never a silent truncation.
  if (matches.length > limit) {
    throw new ProjectFileLimitError({ limit, count: matches.length, patterns });
  }
  return matches;
}
