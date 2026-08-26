/**
 * SEC-1 (V1.8) witnesses — `globProjectFiles` is the one safe fast-glob entry
 * point for project enumeration. Two defenses are pinned here:
 *
 *   1. `followSymbolicLinks: false` — a directory junction / symlink cycle
 *      under `webapp/` must NOT make the walk expand without terminating (the
 *      audit's MEDIUM DoS). Behavioural proof via a real junction cycle plus a
 *      deterministic wiring guard on the injected runner.
 *   2. A hard file-count cap that ABORTS loudly (never silently truncates) past
 *      {@link MAX_PROJECT_FILES}.
 *
 * Fail-on-revert: dropping `followSymbolicLinks: false` lets the junction-cycle
 * test descend the loop (timeout / explosion → red); removing the cap check
 * makes the over-cap test resolve instead of throwing (red).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  globProjectFiles,
  MAX_PROJECT_FILES,
  ProjectFileLimitError,
  type FgRunner,
  type ProjectGlobFgOptions,
} from '../../src/project/glob-project.js';

/**
 * Directory links are creatable unprivileged everywhere: junctions on Windows
 * (the audit's repro vector), plain dir symlinks on POSIX (Node maps the
 * `'junction'` type to a dir symlink off-Windows). Mirrors the helper in
 * containment.test.ts.
 */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, 'junction');
}

describe('globProjectFiles — SEC-1 link-cycle termination', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sapui5-globproj-'));
    mkdirSync(join(projectRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(projectRoot, 'webapp', 'Component.js'), '// js\n', 'utf8');
    writeFileSync(
      join(projectRoot, 'webapp', 'controller', 'A.controller.js'),
      '// js\n',
      'utf8',
    );
    writeFileSync(
      join(projectRoot, 'webapp', 'controller', 'B.controller.js'),
      '// js\n',
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test('a junction cycle under webapp/ terminates fast and is not descended', async () => {
    // The audit's shape: webapp/loop ──► projectRoot (an ancestor). With
    // `followSymbolicLinks: true` (the pre-fix default) fast-glob would recurse
    // webapp/loop/webapp/loop/… without end. With the fix it never enters the
    // link, so only the three real files are returned.
    linkDir(projectRoot, join(projectRoot, 'webapp', 'loop'));
    const matches = await globProjectFiles(['webapp/**/*.js'], {
      cwd: projectRoot,
      absolute: false,
      onlyFiles: true,
      ignore: ['**/node_modules/**'],
    });
    const normalized = matches.map((m) => m.replace(/\\/g, '/')).sort();
    expect(normalized).toEqual([
      'webapp/Component.js',
      'webapp/controller/A.controller.js',
      'webapp/controller/B.controller.js',
    ]);
    // No path threaded through the junction (no `loop/` segment).
    expect(normalized.some((m) => m.includes('/loop/'))).toBe(false);
  });

  test('a normal tree (no links) returns every file and does not throw', async () => {
    const matches = await globProjectFiles(['webapp/**/*.js'], {
      cwd: projectRoot,
      absolute: false,
      onlyFiles: true,
    });
    expect(matches).toHaveLength(3);
  });
});

describe('globProjectFiles — SEC-1 wiring & cap (deterministic, injected runner)', () => {
  function captureRunner(result: string[]): {
    fgImpl: FgRunner;
    seen: { patterns?: string[]; options?: ProjectGlobFgOptions };
  } {
    const seen: { patterns?: string[]; options?: ProjectGlobFgOptions } = {};
    const fgImpl: FgRunner = async (patterns, options) => {
      seen.patterns = patterns;
      seen.options = options;
      return result;
    };
    return { fgImpl, seen };
  }

  test('pins followSymbolicLinks:false and passes options through (fresh arrays)', async () => {
    const { fgImpl, seen } = captureRunner([]);
    const ignore = ['**/node_modules/**'];
    await globProjectFiles(['webapp/**/*.js'], {
      cwd: '/proj',
      ignore,
      absolute: true,
      onlyFiles: true,
      dot: false,
    }, { fgImpl });
    // The load-bearing SEC-1 assertion: link following is off.
    expect(seen.options?.followSymbolicLinks).toBe(false);
    expect(seen.options?.cwd).toBe('/proj');
    expect(seen.options?.absolute).toBe(true);
    expect(seen.options?.onlyFiles).toBe(true);
    expect(seen.options?.dot).toBe(false);
    expect(seen.options?.ignore).toEqual(['**/node_modules/**']);
    // Defensive copies — the wrapper must not alias the caller's arrays.
    expect(seen.options?.ignore).not.toBe(ignore);
  });

  test('returns under-cap results unchanged', async () => {
    const { fgImpl } = captureRunner(['a.js', 'b.js']);
    const out = await globProjectFiles(['webapp/**'], { cwd: '/p' }, { fgImpl, limit: 10 });
    expect(out).toEqual(['a.js', 'b.js']);
  });

  test('count exactly at the cap is allowed (boundary)', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `f${i}.js`);
    const { fgImpl } = captureRunner(ten);
    await expect(
      globProjectFiles(['webapp/**'], { cwd: '/p' }, { fgImpl, limit: 10 }),
    ).resolves.toEqual(ten);
  });

  test('count past the cap aborts loudly with ProjectFileLimitError', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `f${i}.js`);
    const { fgImpl } = captureRunner(eleven);
    await expect(
      globProjectFiles(['webapp/**'], { cwd: '/p' }, { fgImpl, limit: 10 }),
    ).rejects.toThrow(ProjectFileLimitError);
  });

  test('ProjectFileLimitError carries the limit, count and patterns', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `f${i}.js`);
    const { fgImpl } = captureRunner(eleven);
    try {
      await globProjectFiles(['webapp/**/*.js'], { cwd: '/p' }, { fgImpl, limit: 10 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectFileLimitError);
      if (err instanceof ProjectFileLimitError) {
        expect(err.limit).toBe(10);
        expect(err.count).toBe(11);
        expect(err.patterns).toEqual(['webapp/**/*.js']);
        expect(err.message).toMatch(/safety cap/);
      }
    }
  });

  test('the production cap is sized well above any real project', () => {
    expect(MAX_PROJECT_FILES).toBeGreaterThanOrEqual(10_000);
  });
});
