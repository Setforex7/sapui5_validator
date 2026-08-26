/**
 * SPEC §2.6 (clean-tree gate) and §2.14 (changed-files scope).
 * All git operations go through `simple-git` — the CLI never shells out to
 * `git` directly. The `gitImpl` injection point lets tests substitute a fake.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { isExactValidatorAmendment } from '../util/gitignore.js';

/**
 * The subset of `simple-git`'s surface the clean-tree + changed-files helpers
 * use. The injection point is narrowed to this port (rather than the whole
 * `SimpleGit` interface) so a unit test can substitute a fake that *throws*
 * from `status()` — the seam COR-1's fail-closed classification is verified
 * through — without an `as unknown as` cast over `SimpleGit`. A real
 * `simpleGit(...)` instance structurally satisfies it.
 */
export interface GitClient {
  status(): Promise<{ readonly files: readonly { readonly path: string }[] }>;
  show(options: string[]): Promise<string>;
  revparse(options: string[]): Promise<string>;
  diff(options: string[]): Promise<string>;
}

export interface GitOptions {
  /** Inject a `simple-git` instance (or any {@link GitClient}). Default: `simpleGit(projectRoot)`. */
  readonly gitImpl?: GitClient;
}

/**
 * COR-1 (§2.1) — thrown by {@link isWorkingTreeClean} ONLY when the directory
 * is not a git repository at all. The orchestrators treat this case as
 * "proceed" (a non-versioned tree gives the user file-system control, and
 * `--force` exists for explicit overrides); ANY OTHER git failure propagates
 * so the clean-tree gate fails closed instead of silently disabling itself.
 */
export class GitNoRepositoryError extends Error {
  constructor(projectRoot: string, options?: { readonly cause?: unknown }) {
    super(`No git repository at ${projectRoot}; the clean-tree gate cannot run.`, options);
    this.name = 'GitNoRepositoryError';
    Object.setPrototypeOf(this, GitNoRepositoryError.prototype);
  }
}

/**
 * True when a thrown git error is "this is not a git repository" (as opposed
 * to a corrupt index, a locked ref, a permission error, …). Matched on the
 * canonical `git` fatal text, which `simple-git` surfaces verbatim in the
 * error message across platforms and git versions.
 */
function isNoRepositoryError(err: unknown): boolean {
  return err instanceof Error && /not a git repository/i.test(err.message);
}

export interface CleanTreeResult {
  readonly clean: boolean;
  readonly dirtyFiles: readonly string[];
}

function gitFor(projectRoot: string, options: GitOptions): GitClient {
  return options.gitImpl ?? simpleGit(projectRoot);
}

export async function isWorkingTreeClean(
  projectRoot: string,
  options: GitOptions = {},
): Promise<CleanTreeResult> {
  const git = gitFor(projectRoot, options);
  // COR-1 (§2.1): distinguish "no repository" (the only case the caller may
  // treat as "proceed") from every other git failure (corrupt index, locked
  // ref, permission error). Pre-COR-1 the orchestrators caught EVERY throw
  // here as "clean", silently disabling the very gate that exists to stop a
  // run on an un-snapshotted tree. We now surface a typed signal for the
  // no-repo case and let any other error propagate so the gate fails closed.
  let status: { readonly files: readonly { readonly path: string }[] };
  try {
    status = await git.status();
  } catch (err) {
    if (isNoRepositoryError(err)) throw new GitNoRepositoryError(projectRoot, { cause: err });
    throw err;
  }
  let files = status.files.map((f) => f.path);
  // R1.6 (AUDIT §5.6c): the SPEC §2.18 `.gitignore` courtesy amendment runs
  // AFTER this gate, so without this exclusion the NEXT run sees the tool's
  // own one-line append as a dirty tree and refuses to run. Disregard the
  // project's `.gitignore` iff its only divergence from HEAD is that exact
  // amendment; any other edit — even one alongside the amendment — keeps it
  // dirty (the user owns the file). Line-ending smudge (autocrlf) makes the
  // byte comparison fail closed: the file simply stays dirty.
  const gitignoreRepoPath = await projectGitignoreRepoPath(git);
  if (gitignoreRepoPath !== null && files.includes(gitignoreRepoPath)) {
    try {
      const head = await git.show([`HEAD:${gitignoreRepoPath}`]);
      const current = await readFile(join(projectRoot, '.gitignore'), 'utf8');
      if (isExactValidatorAmendment(head, current)) {
        files = files.filter((p) => p !== gitignoreRepoPath);
      }
    } catch {
      // No HEAD version (new/untracked .gitignore) or unreadable working
      // copy — keep the entry; the gate stays conservative.
    }
  }
  return {
    clean: files.length === 0,
    dirtyFiles: [...new Set(files)].sort(),
  };
}

/**
 * Repo-root-relative path of the PROJECT's `.gitignore` (`git status`
 * reports repo-root-relative paths; in a monorepo subdir the project's file
 * carries the `--show-prefix` prefix). Null when the prefix cannot be
 * resolved (e.g. an injected fake git) — the R1.6 exclusion then never
 * fires, preserving legacy behaviour.
 */
async function projectGitignoreRepoPath(git: GitClient): Promise<string | null> {
  try {
    const prefix = (await git.revparse(['--show-prefix'])).trim().split('\\').join('/');
    return `${prefix}.gitignore`;
  } catch {
    return null;
  }
}

/**
 * R1.5 (AUDIT §5.6e) — refs tried, in order, after the requested base fails.
 * `origin/HEAD` first (the remote's true default branch when a remote
 * exists), then the two common trunk names. The requested base itself is
 * always attempt #1 and is deduped out of this chain.
 */
export const BASE_REF_FALLBACK_CHAIN: readonly string[] = Object.freeze([
  'origin/HEAD',
  'main',
  'master',
]);

export interface ChangedFilesWithFallback {
  readonly files: readonly string[];
  /** The ref that actually resolved — not necessarily the requested base. */
  readonly baseUsed: string;
}

/**
 * R1.5 (AUDIT §5.6e): `changedFilesSince` with the fallback ref chain. On a
 * master-trunk repo the SPEC §2.14 default base `main` does not exist, and
 * the previous behaviour silently widened the scope to the full project
 * glob. Tries the requested base, then {@link BASE_REF_FALLBACK_CHAIN};
 * returns `null` only when no ref resolves (caller widens the scope — and
 * is responsible for saying so on stderr).
 */
export async function changedFilesSinceWithFallback(
  projectRoot: string,
  base: string,
  options: GitOptions = {},
): Promise<ChangedFilesWithFallback | null> {
  const chain = [base, ...BASE_REF_FALLBACK_CHAIN.filter((ref) => ref !== base)];
  for (const ref of chain) {
    try {
      const files = await changedFilesSince(projectRoot, ref, options);
      return { files, baseUsed: ref };
    } catch {
      // Ref missing / git unavailable — try the next ref in the chain.
    }
  }
  return null;
}

/**
 * Files changed vs `base` (SPEC §2.14): committed delta `base...HEAD` plus
 * the unstaged/staged set. Paths are returned **projectRoot-relative** (POSIX),
 * deduped, sorted — see the re-basing note below for why this is not a no-op
 * when the project is a monorepo subdirectory.
 */
export async function changedFilesSince(
  projectRoot: string,
  base: string,
  options: GitOptions = {},
): Promise<readonly string[]> {
  const git = gitFor(projectRoot, options);
  const range = `${base}...HEAD`;
  const diffOut = await git.diff(['--name-only', range]);
  const committed = diffOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const status = await git.status();
  const uncommitted = status.files.map((f) => f.path);
  // `git diff` / `git status` report paths relative to the GIT REPOSITORY
  // ROOT, not `projectRoot`. When the SAPUI5 project is a subdirectory of a
  // larger repo (a monorepo — e.g. shop-cart/app/cap_try), those paths carry
  // the subdir prefix, never match the `webapp/`-rooted scope predicates, and
  // the default changed-files scope silently resolves to empty so the
  // validator reviews nothing (G1 — observed live on cap_try). Strip the
  // repo-root→cwd prefix (`git rev-parse --show-prefix`, e.g. `app/cap_try/`)
  // so paths come back projectRoot-relative, and drop anything outside the
  // project (monorepo sibling-package changes). At the repo root the prefix is
  // empty and this is identity. Using git's OWN prefix (rather than comparing
  // its toplevel against `projectRoot`) avoids brittle string mismatches —
  // Windows 8.3 short names, drive-letter casing, symlinked temp dirs.
  let prefix = '';
  try {
    prefix = (await git.revparse(['--show-prefix'])).trim().split('\\').join('/');
  } catch {
    // Prefix not resolvable (e.g. an injected fake git) — treat the paths as
    // already projectRoot-relative (legacy behaviour).
  }
  const projectRelative = [...new Set([...committed, ...uncommitted])]
    .map((p) => p.split('\\').join('/'))
    .filter((p) => prefix === '' || p.startsWith(prefix))
    .map((p) => (prefix === '' ? p : p.slice(prefix.length)))
    .filter((p) => p.length > 0);
  return [...new Set(projectRelative)].sort();
}
