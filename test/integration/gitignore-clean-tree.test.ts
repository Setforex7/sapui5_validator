/**
 * R1.6 (AUDIT §5.6c) — the gitignore courtesy amendment vs the clean-tree
 * gate.
 *
 * Run 1 on a project WITH a `.gitignore` passes the clean-tree gate, then
 * amends `.gitignore` with `.sapui5-validator/`. Pre-R1.6 the NEXT run's
 * gate saw that amendment as a dirty tree and refused to run — the tool
 * dirtied the tree it then refused to run on. `isWorkingTreeClean` now
 * disregards the project's `.gitignore` iff its only divergence from HEAD
 * is the exact amendment this tool writes; anything else stays dirty.
 *
 * (AUDIT §3.1: the bug is unreachable on a no-`.gitignore` project — the
 * courtesy never creates the file — so the fixture here commits one.)
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { runValidate } from '../../src/commands/validate.js';
import { runGenerate } from '../../src/commands/generate.js';
import { isWorkingTreeClean, type GitClient } from '../../src/project/git.js';
import type { ProbeAdapter } from '../../src/project/tooling.js';
import { isExactValidatorAmendment } from '../../src/util/gitignore.js';
import type { VerifyAdapters } from '../../src/verify/pipeline.js';

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'minimal-project');

const ALL_TOOLS_OK: ProbeAdapter = {
  probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }),
};

function adaptersOk(): VerifyAdapters {
  return {
    ui5lint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    eslint: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    karma: async () => ({
      ok: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      testFiles: [],
    }),
  };
}

/** A {@link GitClient} whose every method rejects with `error`. */
function gitWhoseStatusThrows(error: Error): GitClient {
  return {
    status: () => Promise.reject(error),
    show: () => Promise.reject(error),
    revparse: () => Promise.reject(error),
    diff: () => Promise.reject(error),
  };
}

describe('clean-tree gate fails closed on a non-"no-repo" git error (COR-1)', () => {
  // A fresh temp COPY of the fixture per test — never write `.sapui5-validator/`
  // into the real fixture (that would pollute it for every other test that
  // `cpSync`s it, e.g. the `--keep-history` last-run assertion below).
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-cor1-'));
    cpSync(FIXTURE_ROOT, root, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const baseOptions = (gitImpl: GitClient) => ({
    projectRoot: root,
    runner: new FakeClaudeRunner([
      { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
    ]),
    probeAdapter: ALL_TOOLS_OK,
    verifyAdapters: adaptersOk(),
    gitImpl,
  });

  test('a corrupt-index git error aborts the run instead of silently proceeding', async () => {
    // Pre-COR-1 the orchestrator caught EVERY git throw as "clean" and ran on
    // anyway, disabling the gate. The run must now abort with an `error` exit
    // reason that names the git failure and points at `--force`. Reverting the
    // catch to a bare `catch {}` makes this assertion fail (the run proceeds).
    const result = await runValidate(
      baseOptions(gitWhoseStatusThrows(new Error('fatal: index file corrupt'))),
    );
    expect(result.report.exitReason.kind).toBe('error');
    if (result.report.exitReason.kind === 'error') {
      expect(result.report.exitReason.message).toMatch(/working-tree state/i);
      expect(result.report.exitReason.message).toMatch(/index file corrupt/);
      expect(result.report.exitReason.message).toMatch(/--force/);
    }
    expect(result.report.exitCode).toBe(1);
  });

  test('a "not a git repository" error still proceeds (the only swallowed case)', async () => {
    const result = await runValidate(
      baseOptions(
        gitWhoseStatusThrows(new Error('fatal: not a git repository (or any parent): .git')),
      ),
    );
    // No-repo is the documented "proceed" case — the run completes normally and
    // never routes to the COR-1 fail-closed `error` reason.
    expect(result.report.exitReason.kind).not.toBe('error');
    expect(result.report.exitReason.kind).not.toBe('dirty-tree');
  });

  test('runGenerate fails closed too (generate writes files — its catch is the higher-stakes one)', async () => {
    // generate's clean-tree catch is a separate physical branch from validate's;
    // it must ALSO fail closed. Reverting ONLY generate.ts's catch to `catch {}`
    // makes this assertion fail. The throwing gitImpl aborts the run at the
    // clean-tree gate, before the tooling probe — so no adapters are needed.
    const result = await runGenerate({
      projectRoot: root,
      runner: new FakeClaudeRunner([]),
      gitImpl: gitWhoseStatusThrows(new Error('fatal: index file corrupt')),
    });
    expect(result.report.exitReason.kind).toBe('error');
    if (result.report.exitReason.kind === 'error') {
      expect(result.report.exitReason.message).toMatch(/working-tree state/i);
      expect(result.report.exitReason.message).toMatch(/index file corrupt/);
      expect(result.report.exitReason.message).toMatch(/--force/);
    }
    expect(result.report.exitCode).toBe(1);
  });
});

describe('isExactValidatorAmendment (R1.6)', () => {
  test.each([
    ['node_modules/\n', 'node_modules/\n.sapui5-validator/\n', true, 'trailing newline'],
    ['node_modules/', 'node_modules/\n.sapui5-validator/\n', true, 'no trailing newline'],
    ['', '.sapui5-validator/\n', true, 'empty previous'],
    [
      'node_modules/\n',
      'node_modules/\ndist/\n.sapui5-validator/\n',
      false,
      'user edit alongside the amendment',
    ],
    ['node_modules/\n', 'node_modules/\ndist/\n', false, 'unrelated edit only'],
    ['node_modules/\n', 'node_modules/\n', false, 'no change at all'],
  ])('previous=%j current=%j → %s (%s)', (previous, current, expected) => {
    expect(isExactValidatorAmendment(previous, current)).toBe(expected);
  });
});

describe('isWorkingTreeClean disregards the exact amendment (R1.6)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-gitignore-gate-'));
    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.email', 'fixture@example.com');
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('commit.gpgsign', 'false');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await git.add(['.gitignore']);
    await git.commit('add gitignore');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the amendment alone reads as clean', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.sapui5-validator/\n', 'utf8');
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(true);
    expect(result.dirtyFiles).toEqual([]);
  });

  test('the amendment plus a user edit stays dirty', async () => {
    writeFileSync(
      join(root, '.gitignore'),
      'node_modules/\ndist/\n.sapui5-validator/\n',
      'utf8',
    );
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toContain('.gitignore');
  });

  test('a user edit without the amendment stays dirty', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(false);
  });

  test('other dirty files are still reported alongside an amended .gitignore', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.sapui5-validator/\n', 'utf8');
    writeFileSync(join(root, 'stray.txt'), 'x\n', 'utf8');
    const result = await isWorkingTreeClean(root);
    expect(result.clean).toBe(false);
    expect(result.dirtyFiles).toEqual(['stray.txt']);
  });
});

describe('two consecutive validate runs on a fixture WITH a .gitignore (R1.6)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-two-runs-'));
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    // The fixture must HAVE a .gitignore (without the validator entry) for
    // the courtesy amendment — and therefore the bug — to be reachable.
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.email', 'fixture@example.com');
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('commit.gpgsign', 'false');
    await git.add(['.']);
    await git.commit('fixture baseline');
    await git.raw(['branch', '-M', 'master']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the second run must not fail dirty-tree on the first run\'s amendment', async () => {
    const options = () => ({
      projectRoot: root,
      runner: new FakeClaudeRunner([
        { match: /Static check:/, response: { raw: JSON.stringify({ findings: [] }) } },
      ]),
      probeAdapter: ALL_TOOLS_OK,
      verifyAdapters: adaptersOk(),
    });

    const first = await runValidate(options());
    expect(first.report.exitReason.kind).not.toBe('dirty-tree');
    // Run 1 actually amended the file — the precondition for the bug.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.sapui5-validator/');

    const second = await runValidate(options());
    expect(second.report.exitReason.kind).not.toBe('dirty-tree');
  });
});
