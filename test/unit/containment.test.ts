/**
 * v0.8.1 (SECURITY-QUALITY-AUDIT-v0.8.0 V1/V2) — `assertInsideProject`
 * vector witnesses. Every write site in `validate` AND `generate` routes
 * through this one helper, so these vector proofs hold for both commands;
 * the command-level entry points carry their own witnesses in
 * `fix-containment.test.ts` (validate) and `generation-containment.test.ts`
 * (generate). These tests fail on revert of the realpath logic in
 * `src/util/containment.ts` — a lexical `resolve`-only check goes red on the
 * junction/symlink vectors below (the V1 bypass).
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertInsideProject,
  OutsideProjectRootError,
} from '../../src/util/containment.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Directory links are creatable everywhere: unprivileged junctions on
 * Windows (the audit's V1 repro vector), plain symlinks on POSIX. Node maps
 * the `'junction'` type to a regular dir symlink off-Windows.
 */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, 'junction');
}

/**
 * FILE symlinks (the audit's POSIX committed-symlink delivery vector) need
 * privilege/Developer Mode on Windows — probe once and skip the file-symlink
 * witness where they cannot be created. The junction witnesses exercise the
 * same reparse-point mechanism on such hosts.
 */
function canCreateFileSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'sapui5-symlink-probe-'));
  try {
    writeFileSync(join(probe, 't.txt'), 'x', 'utf8');
    symlinkSync(join(probe, 't.txt'), join(probe, 'l.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const FILE_SYMLINKS_OK = canCreateFileSymlink();

/** 8.3 short alias of `p`, or null when unavailable/disabled on the volume. */
function shortPathOf(p: string): string | null {
  if (!IS_WINDOWS) return null;
  try {
    // windowsVerbatimArguments: Node's default cmd-arg quoting mangles the
    // inner quotes and `%~sI` never sees the real path.
    // `windowsVerbatimArguments` is honoured by the underlying spawnSync but
    // absent from @types/node's execFileSync options type — widen the literal
    // with a typed intersection rather than an `any`/cast (CLAUDE.md).
    const opts: ExecFileSyncOptionsWithStringEncoding & {
      windowsVerbatimArguments?: boolean;
    } = { encoding: 'utf8', windowsVerbatimArguments: true };
    const out = execFileSync('cmd', ['/c', `for %I in ("${p}") do @echo %~sI`], opts).trim();
    return out.length > 0 && out.toLowerCase() !== p.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}

describe('assertInsideProject (v0.8.1 V1/V2)', () => {
  let base: string;
  let projectRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'sapui5-containment-'));
    projectRoot = join(base, 'project');
    outsideDir = join(base, 'outside');
    mkdirSync(join(projectRoot, 'webapp'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('`..`-traversal target is blocked', async () => {
    await expect(
      assertInsideProject('../outside/evil.js', projectRoot),
    ).rejects.toThrow(OutsideProjectRootError);
    await expect(
      assertInsideProject(join(projectRoot, '..', 'outside', 'evil.js'), projectRoot),
    ).rejects.toThrow(/outside project root/);
  });

  test('absolute out-of-tree target is blocked', async () => {
    await expect(
      assertInsideProject(join(outsideDir, 'evil.js'), projectRoot),
    ).rejects.toThrow(OutsideProjectRootError);
  });

  test('the project root itself is not a writable target', async () => {
    await expect(assertInsideProject(projectRoot, projectRoot)).rejects.toThrow(
      OutsideProjectRootError,
    );
    await expect(assertInsideProject('.', projectRoot)).rejects.toThrow(
      OutsideProjectRootError,
    );
  });

  test('V1 vector: directory junction/symlink under webapp pointing out of tree is blocked', async () => {
    // The audit's verified repro shape: proj/webapp/linked ──► ../outside.
    // A lexical resolve()-based check reports this as in-tree (BLOCKED=false
    // in the audit's run); realpath must refuse it.
    linkDir(outsideDir, join(projectRoot, 'webapp', 'linked'));
    await expect(
      assertInsideProject(join(projectRoot, 'webapp', 'linked', 'target.js'), projectRoot),
    ).rejects.toThrow(OutsideProjectRootError);
  });

  test.runIf(FILE_SYMLINKS_OK)(
    'V1 vector (POSIX delivery): file symlink to an out-of-tree file is blocked',
    async () => {
      const victim = join(outsideDir, 'victim.js');
      writeFileSync(victim, 'original\n', 'utf8');
      symlinkSync(victim, join(projectRoot, 'webapp', 'Linked.controller.js'), 'file');
      await expect(
        assertInsideProject(join(projectRoot, 'webapp', 'Linked.controller.js'), projectRoot),
      ).rejects.toThrow(OutsideProjectRootError);
    },
  );

  test('dangling link in the target path fails closed', async () => {
    // A write through a dangling link would CREATE the file at the link's
    // target — the assert must refuse, not treat the link as a plain
    // to-be-created component.
    const ghostTarget = join(outsideDir, 'ghost');
    mkdirSync(ghostTarget);
    linkDir(ghostTarget, join(projectRoot, 'webapp', 'dangling'));
    rmSync(ghostTarget, { recursive: true, force: true });
    await expect(
      assertInsideProject(join(projectRoot, 'webapp', 'dangling', 'new.js'), projectRoot),
    ).rejects.toThrow(OutsideProjectRootError);
  });

  test.runIf(IS_WINDOWS)(
    'Windows aliasing: differently-cased paths resolve consistently',
    async () => {
      // In-tree target addressed through a case-mangled root → allowed
      // (win32 `relative` is case-insensitive; real-to-real comparison keeps
      // both sides canonical-enough for it).
      const mangledRoot =
        projectRoot.slice(0, 1).toLowerCase() + projectRoot.slice(1).toUpperCase();
      await expect(
        assertInsideProject(join(mangledRoot, 'webapp', 'ok.js'), projectRoot),
      ).resolves.toBeUndefined();
      // Escaping junction addressed through a case-mangled path → still
      // blocked: aliasing must not bypass link resolution.
      linkDir(outsideDir, join(projectRoot, 'webapp', 'linkedcase'));
      await expect(
        assertInsideProject(
          join(projectRoot, 'WEBAPP', 'LINKEDCASE', 'evil.js'),
          projectRoot,
        ),
      ).rejects.toThrow(OutsideProjectRootError);
    },
  );

  test.runIf(IS_WINDOWS)(
    'Windows aliasing: 8.3 short-name paths resolve consistently',
    async (ctx) => {
      // An in-tree long-named dir through its short alias → allowed; an
      // escaping junction through its short alias → blocked. Skipped when
      // 8.3 generation is disabled on the volume (no alias exists to test).
      mkdirSync(join(projectRoot, 'longdirectoryname'), { recursive: true });
      linkDir(outsideDir, join(projectRoot, 'linkedlongdirectoryname'));
      const shortInTree = shortPathOf(join(projectRoot, 'longdirectoryname'));
      const shortLinked = shortPathOf(join(projectRoot, 'linkedlongdirectoryname'));
      if (shortInTree === null || shortLinked === null) {
        ctx.skip();
        return;
      }
      await expect(
        assertInsideProject(join(shortInTree, 'ok.js'), projectRoot),
      ).resolves.toBeUndefined();
      await expect(
        assertInsideProject(join(shortLinked, 'evil.js'), projectRoot),
      ).rejects.toThrow(OutsideProjectRootError);
    },
  );

  test('control: a normal in-tree target (existing or to-be-created) is allowed', async () => {
    writeFileSync(join(projectRoot, 'webapp', 'Main.controller.js'), '// x\n', 'utf8');
    await expect(
      assertInsideProject(join(projectRoot, 'webapp', 'Main.controller.js'), projectRoot),
    ).resolves.toBeUndefined();
    // Deeply nested, none of the directories exist yet (the generate shape).
    await expect(
      assertInsideProject(
        join(projectRoot, 'webapp', 'test', 'unit', 'controller', 'App.qunit.js'),
        projectRoot,
      ),
    ).resolves.toBeUndefined();
  });

  test('control: a link that stays INSIDE the project is allowed (no over-blocking)', async () => {
    mkdirSync(join(projectRoot, 'webapp', 'real'), { recursive: true });
    linkDir(join(projectRoot, 'webapp', 'real'), join(projectRoot, 'webapp', 'alias'));
    await expect(
      assertInsideProject(join(projectRoot, 'webapp', 'alias', 'ok.js'), projectRoot),
    ).resolves.toBeUndefined();
  });
});
