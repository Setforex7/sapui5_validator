/**
 * R1.5 (AUDIT §5.6e) — base-ref fallback chain + loud full-scope widening.
 *
 * The SPEC §2.14 default base is `main`. On a master-trunk repo that ref
 * does not exist, and pre-R1.5 `resolveFileScope` silently widened the
 * scope to the full project glob — zero signal for CI. Now:
 *
 *   - `changedFilesSinceWithFallback` walks requested → origin/HEAD →
 *     main → master and reports which ref it used;
 *   - `resolveFileScope` emits a one-line stderr notice whenever it uses a
 *     fallback ref, and another when no ref resolves and the scope widens.
 *
 * Real `git` in a tmpdir, same pattern as git.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { resolveFileScope } from '../../src/commands/validate.js';
import {
  BASE_REF_FALLBACK_CHAIN,
  changedFilesSinceWithFallback,
} from '../../src/project/git.js';

async function initMasterTrunkRepo(root: string): Promise<void> {
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'fixture@example.com');
  await git.addConfig('user.name', 'Fixture');
  await git.addConfig('commit.gpgsign', 'false');
  writeFileSync(join(root, 'README'), 'initial\n');
  await git.add(['README']);
  await git.commit('initial');
  // Deterministic trunk name regardless of the machine's init.defaultBranch.
  await git.raw(['branch', '-M', 'master']);
}

function seed(root: string, rel: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '// stub\n', 'utf8');
}

describe('changedFilesSinceWithFallback (R1.5)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-ref-chain-'));
    await initMasterTrunkRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the chain is requested-base first, then origin/HEAD, main, master', () => {
    expect(BASE_REF_FALLBACK_CHAIN).toEqual(['origin/HEAD', 'main', 'master']);
  });

  test('an existing requested base is used directly (no fallback)', async () => {
    const git = simpleGit(root);
    await git.raw(['branch', 'baseline']);
    seed(root, 'changed.txt');
    const result = await changedFilesSinceWithFallback(root, 'baseline');
    expect(result?.baseUsed).toBe('baseline');
    expect(result?.files).toContain('changed.txt');
  });

  test('master-trunk repo: requested "main" falls back to "master"', async () => {
    seed(root, 'changed.txt');
    const result = await changedFilesSinceWithFallback(root, 'main');
    expect(result?.baseUsed).toBe('master');
    expect(result?.files).toContain('changed.txt');
  });

  test('no usable ref (not a git repo) returns null', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sapui5-ref-chain-nogit-'));
    try {
      const result = await changedFilesSinceWithFallback(bare, 'main');
      expect(result).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('resolveFileScope base-ref visibility (R1.5)', () => {
  let root: string;
  let stderrSpy: MockInstance<(typeof process.stderr)['write']>;

  function stderrText(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-ref-scope-'));
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  test('master-trunk repo: scope stays changed-files (NOT the full glob) and the fallback is announced', async () => {
    await initMasterTrunkRepo(root);
    const git = simpleGit(root);
    seed(root, 'webapp/controller/Committed.controller.js');
    await git.add(['webapp/controller/Committed.controller.js']);
    await git.commit('committed controller');
    // Uncommitted change — the only thing a changed-files scope should see.
    seed(root, 'webapp/controller/Changed.controller.js');

    const scope = await resolveFileScope({ projectRoot: root, all: false });

    const controllers = scope.controllerJs.map((p) => p.split('\\').join('/'));
    expect(controllers.some((p) => p.endsWith('Changed.controller.js'))).toBe(true);
    // The committed-and-unchanged controller proves the scope did NOT widen
    // to the full project glob.
    expect(controllers.some((p) => p.endsWith('Committed.controller.js'))).toBe(false);
    expect(stderrText()).toMatch(/base ref "main" not found; comparing against "master"/);
  });

  test('no git at all: the full-glob widening is announced on stderr', async () => {
    seed(root, 'webapp/controller/Only.controller.js');

    const scope = await resolveFileScope({ projectRoot: root, all: false });

    expect(
      scope.controllerJs.some((p) =>
        p.split('\\').join('/').endsWith('Only.controller.js'),
      ),
    ).toBe(true);
    expect(stderrText()).toMatch(/scope widened to the full project glob/);
    expect(stderrText()).toMatch(/tried main, origin\/HEAD, master/);
  });

  test('existing requested base produces no stderr notice', async () => {
    await initMasterTrunkRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'baseline']);
    seed(root, 'webapp/controller/Changed.controller.js');

    await resolveFileScope({ projectRoot: root, all: false, base: 'baseline' });

    expect(stderrText()).toBe('');
  });
});
