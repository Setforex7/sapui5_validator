import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  changedFilesSince,
  GitNoRepositoryError,
  isWorkingTreeClean,
  type GitClient,
} from '../../src/project/git.js';

/** Minimal {@link GitClient} whose `status()` rejects with `statusError`. */
function gitWhoseStatusThrows(statusError: Error): GitClient {
  return {
    status: () => Promise.reject(statusError),
    show: () => Promise.resolve(''),
    revparse: () => Promise.resolve(''),
    diff: () => Promise.resolve(''),
  };
}

async function initRepo(root: string): Promise<void> {
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'fixture@example.com');
  await git.addConfig('user.name', 'Fixture');
  await git.addConfig('commit.gpgsign', 'false');
}

describe('isWorkingTreeClean', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-git-'));
    await initRepo(root);
    writeFileSync(join(root, 'README'), 'initial\n');
    const git = simpleGit(root);
    await git.add(['README']);
    await git.commit('initial');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('clean tree after commit', async () => {
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(true);
    expect(result.dirtyFiles).toEqual([]);
  });

  test('modifying a tracked file makes the tree dirty', async () => {
    writeFileSync(join(root, 'README'), 'second\n');
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toContain('README');
  });

  test('untracked file makes the tree dirty', async () => {
    writeFileSync(join(root, 'NEW.txt'), 'hello\n');
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toContain('NEW.txt');
  });
});

describe('isWorkingTreeClean — git error classification (COR-1)', () => {
  test('"not a git repository" surfaces as a typed GitNoRepositoryError', async () => {
    const git = gitWhoseStatusThrows(
      new Error('fatal: not a git repository (or any of the parent directories): .git'),
    );
    await expect(isWorkingTreeClean('/proj', { gitImpl: git })).rejects.toBeInstanceOf(
      GitNoRepositoryError,
    );
  });

  test('any OTHER git failure propagates verbatim — never swallowed as clean', async () => {
    // The fail-closed contract: a corrupt index (or any non-"no repo" git
    // error) must NOT be reclassified as no-repo and must NOT resolve to a
    // clean tree. Reverting the classification (catch-all → "clean") makes
    // this reject expectation fail.
    const corrupt = new Error('error: bad index file sha1 signature\nfatal: index file corrupt');
    const git = gitWhoseStatusThrows(corrupt);
    let caught: unknown;
    try {
      await isWorkingTreeClean('/proj', { gitImpl: git });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(corrupt);
    expect(caught).not.toBeInstanceOf(GitNoRepositoryError);
  });
});

describe('changedFilesSince', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-git-since-'));
    await initRepo(root);
    const git = simpleGit(root);
    writeFileSync(join(root, 'a.txt'), 'a1\n');
    await git.add(['a.txt']);
    await git.commit('initial');
    await git.branch(['baseline']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('committed change vs base appears in the diff', async () => {
    const git = simpleGit(root);
    writeFileSync(join(root, 'b.txt'), 'b1\n');
    await git.add(['b.txt']);
    await git.commit('add b');
    const result = await changedFilesSince(root, 'baseline');
    expect(result).toContain('b.txt');
  });

  test('uncommitted change is included alongside committed ones', async () => {
    const git = simpleGit(root);
    writeFileSync(join(root, 'b.txt'), 'b1\n');
    await git.add(['b.txt']);
    await git.commit('add b');
    writeFileSync(join(root, 'c.txt'), 'c1\n');
    const result = await changedFilesSince(root, 'baseline');
    expect(result).toContain('b.txt');
    expect(result).toContain('c.txt');
  });

  test('paths are deduped and sorted', async () => {
    const git = simpleGit(root);
    writeFileSync(join(root, 'b.txt'), 'b1\n');
    await git.add(['b.txt']);
    await git.commit('add b');
    writeFileSync(join(root, 'b.txt'), 'b2\n');
    const result = await changedFilesSince(root, 'baseline');
    expect(result.filter((p) => p === 'b.txt').length).toBe(1);
    expect([...result]).toEqual([...result].sort());
  });

  test('G1 (V1.5): a monorepo subdir project gets projectRoot-relative paths, not repo-root-relative', async () => {
    // The project lives at <repo>/app/proj; git reports repo-root-relative
    // paths (app/proj/webapp/...). changedFilesSince must re-base them onto
    // projectRoot so the webapp/-rooted scope predicates match. Pre-fix this
    // returned the app/proj/ prefix and the default scope silently emptied —
    // exactly what was observed live on cap_try (shop-cart/app/cap_try).
    const git = simpleGit(root);
    mkdirSync(join(root, 'app', 'proj', 'webapp', 'controller'), { recursive: true });
    writeFileSync(
      join(root, 'app', 'proj', 'webapp', 'controller', 'Main.controller.js'),
      '// v1\n',
    );
    await git.add(['app/proj/webapp/controller/Main.controller.js']);
    await git.commit('add controller');
    const result = await changedFilesSince(join(root, 'app', 'proj'), 'baseline');
    expect(result).toContain('webapp/controller/Main.controller.js');
    expect(result).not.toContain('app/proj/webapp/controller/Main.controller.js');
  });

  test('G1 (V1.5): changes in a sibling package outside the project are dropped', async () => {
    const git = simpleGit(root);
    mkdirSync(join(root, 'app', 'proj', 'webapp'), { recursive: true });
    writeFileSync(join(root, 'app', 'proj', 'webapp', 'in.js'), '// in\n');
    mkdirSync(join(root, 'srv'), { recursive: true });
    writeFileSync(join(root, 'srv', 'out.js'), '// out\n');
    await git.add(['app/proj/webapp/in.js', 'srv/out.js']);
    await git.commit('add both');
    const result = await changedFilesSince(join(root, 'app', 'proj'), 'baseline');
    expect(result).toContain('webapp/in.js');
    expect(result.some((p) => p.startsWith('../') || p.includes('srv'))).toBe(false);
  });
});
