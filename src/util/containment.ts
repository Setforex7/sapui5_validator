/**
 * v0.8.1 (SECURITY-QUALITY-AUDIT-v0.8.0 V1/V2) — realpath-based write
 * containment, shared by every site that writes to a path under the scanned
 * project.
 *
 * The pre-0.8.1 guard compared `path.resolve` outputs, which is lexical:
 * a symlink/junction under `webapp/` slipped past it and `writeFile`
 * followed the link out of the project (V1, verified with a Windows
 * directory junction). The `generate` write path had no guard at all (V2).
 * This helper dereferences links on BOTH sides before comparing:
 *
 *   1. `realpath` the project root;
 *   2. `realpath` the NEAREST EXISTING ancestor of the target (the target
 *      file itself usually does not exist yet), then re-append the
 *      not-yet-created trailing components — which are already lexically
 *      normalized, so no `..` survives into the re-append;
 *   3. assert the result is contained under the real root.
 *
 * Real-to-real comparison also makes the check immune to Windows path
 * aliasing: an 8.3 short-named or differently-cased root and target resolve
 * to the same canonical form before `relative()` (which is itself
 * case-insensitive on win32) compares them.
 *
 * On escape the assert THROWS — a loud, named refusal, never a silent skip
 * (R2.2 discipline). A path component that exists but cannot be
 * realpath'd (e.g. a dangling symlink) also throws: the write would be
 * created at the link's target, so the check fails closed.
 */

import { realpath as realpathCb } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * `realpath.native` (GetFinalPathNameByHandle on Windows), not the JS
 * implementation: the JS walk resolves links but does NOT canonicalize 8.3
 * short names or on-disk case, so an aliased in-tree path (`LONGDI~1\…`)
 * would be wrongly refused against the long-named root. Native
 * canonicalizes both sides to the same form. (The 8.3 witness in
 * test/unit/containment.test.ts goes red on revert to the JS realpath.)
 */
const realpath = promisify(realpathCb.native);

export class OutsideProjectRootError extends Error {
  readonly targetPath: string;
  readonly projectRoot: string;

  constructor(args: {
    readonly targetPath: string;
    readonly projectRoot: string;
    readonly detail: string;
  }) {
    super(
      `refusing to write outside project root: ${args.targetPath} ${args.detail} ` +
        `(project root: ${args.projectRoot})`,
    );
    this.name = 'OutsideProjectRootError';
    this.targetPath = args.targetPath;
    this.projectRoot = args.projectRoot;
  }
}

/**
 * Throw {@link OutsideProjectRootError} unless `targetPath` — after resolving
 * every symlink/junction in its existing ancestry — lies strictly inside the
 * real `projectRoot`. `targetPath` may be relative (resolved against
 * `projectRoot`) and need not exist yet. The project root itself is not a
 * writable target.
 *
 * Callers MUST pass the exact path string they are about to write, so the
 * asserted path and the written path cannot diverge.
 */
export async function assertInsideProject(
  targetPath: string,
  projectRoot: string,
): Promise<void> {
  const realRoot = await realpath(resolve(projectRoot));
  const targetAbs = resolve(projectRoot, targetPath);

  // Walk up to the nearest ancestor that exists ON DISK (lstat — a dangling
  // link counts as existing, so it is realpath'd below and fails closed
  // rather than being treated as a plain to-be-created component).
  let existing = targetAbs;
  const pending: string[] = [];
  while (!(await lexists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    pending.unshift(basename(existing));
    existing = parent;
  }

  let realExisting: string;
  try {
    realExisting = await realpath(existing);
  } catch {
    throw new OutsideProjectRootError({
      targetPath,
      projectRoot,
      detail: `has an existing ancestor ${existing} whose real path cannot be resolved (dangling link?) — failing closed`,
    });
  }

  const realTarget = join(realExisting, ...pending);
  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new OutsideProjectRootError({
      targetPath,
      projectRoot,
      detail: `resolves to ${realTarget}, which escapes the project root`,
    });
  }
}

async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
