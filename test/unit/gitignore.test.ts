import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ensureSelfScopedIgnore,
  ensureValidatorDirIgnored,
} from '../../src/util/gitignore.js';
import { OutsideProjectRootError } from '../../src/util/containment.js';

describe('ensureValidatorDirIgnored', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sapui5-gitignore-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns "no-gitignore" without creating a file when none exists', async () => {
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome).toEqual({ kind: 'no-gitignore' });
  });

  test('appends `.sapui5-validator/` when missing from existing .gitignore', async () => {
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules\ndist\n', 'utf8');
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome.kind).toBe('amended');
    const contents = readFileSync(gitignorePath, 'utf8');
    expect(contents).toBe('node_modules\ndist\n.sapui5-validator/\n');
  });

  test('inserts a leading newline if existing .gitignore has no trailing newline', async () => {
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules', 'utf8');
    await ensureValidatorDirIgnored(dir);
    const contents = readFileSync(gitignorePath, 'utf8');
    expect(contents).toBe('node_modules\n.sapui5-validator/\n');
  });

  test.each([
    '.sapui5-validator',
    '.sapui5-validator/',
    '/.sapui5-validator/',
    '/.sapui5-validator',
  ])('detects existing entry %s and does not amend', async (line) => {
    const gitignorePath = join(dir, '.gitignore');
    const original = `node_modules\n${line}\n`;
    writeFileSync(gitignorePath, original, 'utf8');
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome.kind).toBe('already-present');
    expect(readFileSync(gitignorePath, 'utf8')).toBe(original);
  });

  test('ignores commented matches', async () => {
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, '# .sapui5-validator/\n', 'utf8');
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome.kind).toBe('amended');
    expect(readFileSync(gitignorePath, 'utf8')).toBe('# .sapui5-validator/\n.sapui5-validator/\n');
  });

  test('does not match a substring like `.sapui5-validator-old`', async () => {
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, '.sapui5-validator-old/\n', 'utf8');
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome.kind).toBe('amended');
  });

  // COR-11 — a pre-existing glob / parent pattern that already covers the dir
  // must be recognized so a re-run does not spuriously re-amend `.gitignore`.
  test.each([
    ['.sapui5*', 'prefix glob'],
    ['*-validator/', 'suffix glob'],
    ['**/.sapui5-validator', 'double-star prefix'],
    ['!.sapui5-validator', 'negation'],
  ])('COR-11: a covering pattern %s (%s) triggers no re-amend', async (line) => {
    const gitignorePath = join(dir, '.gitignore');
    const original = `node_modules\n${line}\n`;
    writeFileSync(gitignorePath, original, 'utf8');
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome.kind).toBe('already-present');
    expect(readFileSync(gitignorePath, 'utf8')).toBe(original);
  });

  test('COR-11: a child-only pattern (sub/.sapui5-validator) does NOT cover the root dir', async () => {
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules\nsub/.sapui5-validator/\n', 'utf8');
    const outcome = await ensureValidatorDirIgnored(dir);
    expect(outcome.kind).toBe('amended');
  });
});

/**
 * v0.8.1 V3 (SECURITY-QUALITY-AUDIT-v0.8.0) — self-scoped audit-trail
 * ignore. Fails on revert of `ensureSelfScopedIgnore` in
 * `src/util/gitignore.ts`: without the self-scoped file, the
 * no-root-`.gitignore` witness's `git check-ignore` goes red (the audit
 * trail was silently git-trackable on such projects).
 */
describe('ensureSelfScopedIgnore (v0.8.1 V3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sapui5-selfignore-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function git(args: readonly string[], cwd: string): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
  }

  /** True iff git ignores `rel` inside the repo at `cwd`. */
  function gitIgnores(rel: string, cwd: string): boolean {
    try {
      git(['check-ignore', '-q', rel], cwd);
      return true;
    } catch {
      return false;
    }
  }

  test('creates .sapui5-validator/.gitignore containing `*` (dir created on demand)', async () => {
    const outcome = await ensureSelfScopedIgnore(dir);
    expect(outcome.kind).toBe('written');
    expect(readFileSync(join(dir, '.sapui5-validator', '.gitignore'), 'utf8')).toBe('*\n');
  });

  test('is idempotent: an existing self-scoped ignore is left untouched', async () => {
    await ensureSelfScopedIgnore(dir);
    writeFileSync(join(dir, '.sapui5-validator', '.gitignore'), '*\n# user note\n', 'utf8');
    const outcome = await ensureSelfScopedIgnore(dir);
    expect(outcome.kind).toBe('already-present');
    expect(readFileSync(join(dir, '.sapui5-validator', '.gitignore'), 'utf8')).toBe(
      '*\n# user note\n',
    );
  });

  test('project WITHOUT a root .gitignore: audit trail is git-ignored, no root .gitignore created', async () => {
    git(['init', '-q'], dir);
    await ensureSelfScopedIgnore(dir);
    // Simulate a run's audit trail.
    mkdirSync(join(dir, '.sapui5-validator', 'last-run', 'prompts'), { recursive: true });
    writeFileSync(
      join(dir, '.sapui5-validator', 'last-run', 'prompts', 'call-1.txt'),
      'full source + prompt\n',
      'utf8',
    );
    expect(gitIgnores('.sapui5-validator/last-run/prompts/call-1.txt', dir)).toBe(true);
    expect(gitIgnores('.sapui5-validator/.gitignore', dir)).toBe(true);
    // The user's root .gitignore was NOT created (SPEC §2.18: the user owns it).
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    // Nothing under the validator dir reaches `git status` — including the
    // self-scoped ignore itself (`*` matches it), so the clean-tree gate is
    // never dirtied by this tool's own working dir.
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });

  test('project WITH a root .gitignore: both mechanisms coexist without conflict', async () => {
    git(['init', '-q'], dir);
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n', 'utf8');
    await ensureValidatorDirIgnored(dir); // the SPEC §2.18 courtesy amend
    await ensureSelfScopedIgnore(dir);
    mkdirSync(join(dir, '.sapui5-validator', 'last-run'), { recursive: true });
    writeFileSync(join(dir, '.sapui5-validator', 'last-run', 'r.json'), '{}\n', 'utf8');
    expect(gitIgnores('.sapui5-validator/last-run/r.json', dir)).toBe(true);
    // The root amend behaved exactly as before — one appended line.
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.sapui5-validator/\n',
    );
  });

  test('v0.8.1 V1: a linked .sapui5-validator dir escaping the project is refused', async () => {
    // A committed symlink at `.sapui5-validator` would redirect the whole
    // audit trail (full source + LLM transcripts) out of the tree — the
    // up-front assert must throw, and the orchestrators abort on it.
    const outside = mkdtempSync(join(tmpdir(), 'sapui5-selfignore-outside-'));
    try {
      symlinkSync(outside, join(dir, '.sapui5-validator'), 'junction');
      await expect(ensureSelfScopedIgnore(dir)).rejects.toThrow(OutsideProjectRootError);
      expect(existsSync(join(outside, '.gitignore'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
