/**
 * V1.1-6 (Bug 4) unit tests for the vendor / minified scope-exclusion list
 * implemented in [src/commands/validate.ts](../../src/commands/validate.ts).
 *
 * Three behaviors are exercised:
 *
 *   1. The `isScopeExcluded` predicate matches the documented patterns
 *      (`*.min.js`, `*.min.css`, `vendor/`, `thirdparty/`, `third-party/`,
 *      `dist/`) and rejects unrelated paths so first-party SAPUI5 source
 *      under `webapp/` stays in scope.
 *
 *   2. `classifyChangedFiles` (the git-changed-since-base path) intersects
 *      the exclusion list — a vendor blob that appears in a diff against
 *      `main` must NOT enter scope, even when it is a syntactically valid
 *      `webapp/**\/*.js` file.
 *
 *   3. `resolveFileScope` throws {@link ExcludedPathScopeError} when an
 *      explicit `--path` argument names an excluded file. The orchestrator
 *      converts the throw into an `exit reason: error` so the user sees
 *      *why* the file was refused. Non-excluded explicit paths pass through
 *      and produce the expected single-file scope.
 *
 * These tests are pure unit tests — no real `claude`, no real `ui5lint`,
 * no `git` invocation. They run inside the default fast `npm test` scope.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ExcludedPathScopeError,
  classifyChangedFiles,
  isScopeExcluded,
  resolveFileScope,
} from '../../src/commands/validate.js';

describe('isScopeExcluded — predicate semantics', () => {
  test.each([
    ['webapp/util/xlsx.full.min.js', true, '*.min.js extension'],
    ['webapp/css/theme.min.css', true, '*.min.css extension'],
    ['webapp/vendor/lib.js', true, 'top-level vendor/ segment'],
    ['webapp/util/vendor/inner.js', true, 'nested vendor/ segment'],
    ['webapp/thirdparty/some-lib.js', true, 'thirdparty/ segment'],
    ['webapp/third-party/some-lib.js', true, 'third-party/ segment'],
    ['webapp/dist/bundle.js', true, 'dist/ segment'],
    // First-party paths must NOT be excluded — these are exactly the shapes
    // the V1 validator is built to scope.
    ['webapp/controller/View1.controller.js', false, 'standard controller'],
    ['webapp/view/View1.view.xml', false, 'standard view XML'],
    ['webapp/test/unit/View1.qunit.js', false, 'standard qunit test'],
    ['webapp/manifest.json', false, 'manifest passes'],
    ['webapp/Component.js', false, 'top-level Component.js passes'],
    ['webapp/util/Formatter.js', false, 'unrelated util .js passes'],
    // A `min` substring that isn't the actual `.min.js` extension is not
    // enough; we match on the full suffix.
    ['webapp/util/admin.js', false, 'admin.js is not a minified file'],
  ])('isScopeExcluded(%j) === %s (%s)', (rel, expected) => {
    expect(isScopeExcluded(rel)).toBe(expected);
  });

  test('windows-style separators are normalised before matching', () => {
    expect(isScopeExcluded('webapp\\util\\xlsx.full.min.js')).toBe(true);
    expect(isScopeExcluded('webapp\\vendor\\lib.js')).toBe(true);
    expect(isScopeExcluded('webapp\\controller\\View1.controller.js')).toBe(false);
  });
});

describe('classifyChangedFiles — intersection with scope exclusion', () => {
  let root: string;

  function seed(relPaths: readonly string[]): void {
    for (const rel of relPaths) {
      const abs = join(root, ...rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, '// stub\n', 'utf8');
    }
  }

  test('vendor / minified files in the diff are filtered out before scope assembly', () => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-scope-'));
    try {
      seed([
        'webapp/util/xlsx.full.min.js',
        'webapp/vendor/lib.js',
        'webapp/thirdparty/q.js',
        'webapp/dist/bundle.js',
        'webapp/controller/Main.controller.js',
        'webapp/view/Main.view.xml',
        'webapp/test/unit/Main.qunit.js',
      ]);
      const changed = [
        'webapp/util/xlsx.full.min.js',
        'webapp/vendor/lib.js',
        'webapp/thirdparty/q.js',
        'webapp/dist/bundle.js',
        'webapp/controller/Main.controller.js',
        'webapp/view/Main.view.xml',
        'webapp/test/unit/Main.qunit.js',
      ];
      const scope = classifyChangedFiles(changed, root);
      // Only the first-party paths survive — none of the excluded ones do.
      expect(scope.controllerJs.map((p) => p.replace(/\\/g, '/'))).toEqual([
        `${root.replace(/\\/g, '/')}/webapp/controller/Main.controller.js`,
      ]);
      expect(scope.viewXml.map((p) => p.replace(/\\/g, '/'))).toEqual([
        `${root.replace(/\\/g, '/')}/webapp/view/Main.view.xml`,
      ]);
      expect(scope.qunitTest.map((p) => p.replace(/\\/g, '/'))).toEqual([
        `${root.replace(/\\/g, '/')}/webapp/test/unit/Main.qunit.js`,
      ]);
      expect(scope.includesProjectScope).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveFileScope — explicit path hits exclusion', () => {
  test('throws ExcludedPathScopeError when --path is a *.min.js', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sapui5-scope-'));
    try {
      mkdirSync(join(root, 'webapp', 'util'), { recursive: true });
      writeFileSync(join(root, 'webapp', 'util', 'xlsx.full.min.js'), '// vendor\n');
      await expect(
        resolveFileScope({
          projectRoot: root,
          all: false,
          path: 'webapp/util/xlsx.full.min.js',
        }),
      ).rejects.toBeInstanceOf(ExcludedPathScopeError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('error message documents the workaround (--force-include)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sapui5-scope-'));
    try {
      mkdirSync(join(root, 'webapp', 'vendor'), { recursive: true });
      writeFileSync(join(root, 'webapp', 'vendor', 'lib.js'), '// vendor\n');
      try {
        await resolveFileScope({
          projectRoot: root,
          all: false,
          path: 'webapp/vendor/lib.js',
        });
        throw new Error('expected resolveFileScope to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ExcludedPathScopeError);
        const e = err as ExcludedPathScopeError;
        expect(e.relPath).toBe('webapp/vendor/lib.js');
        expect(e.message).toContain('--force-include');
        // The message must surface *which* pattern caught it so the user
        // can decide whether to rename the file or wait for V1.2 config.
        expect(e.message).toContain('vendor/');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-excluded explicit path passes through to single-file scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sapui5-scope-'));
    try {
      mkdirSync(join(root, 'webapp', 'controller'), { recursive: true });
      const ctrlAbs = join(root, 'webapp', 'controller', 'Main.controller.js');
      writeFileSync(ctrlAbs, '// ok\n');
      const scope = await resolveFileScope({
        projectRoot: root,
        all: false,
        path: 'webapp/controller/Main.controller.js',
      });
      expect(scope.controllerJs).toEqual([ctrlAbs]);
      expect(scope.viewXml).toEqual([]);
      expect(scope.qunitTest).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('E2 — webapp/test/_failing/ is out of validate scope', () => {
  function seed(root: string, rel: string): void {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '// stub\n', 'utf8');
  }

  test('classifyChangedFiles drops a quarantined .failing.qunit.js but keeps real tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'sapui5-failing-'));
    try {
      seed(root, 'webapp/test/unit/Main.qunit.js');
      seed(root, 'webapp/test/_failing/Broken.failing.qunit.js');
      const scope = classifyChangedFiles(
        ['webapp/test/unit/Main.qunit.js', 'webapp/test/_failing/Broken.failing.qunit.js'],
        root,
      );
      const rels = scope.qunitTest.map((p) => p.replace(/\\/g, '/'));
      expect(rels.some((p) => p.endsWith('webapp/test/unit/Main.qunit.js'))).toBe(true);
      expect(rels.some((p) => p.includes('/test/_failing/'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolveFileScope --all excludes the quarantine directory from the glob', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sapui5-failing-'));
    try {
      seed(root, 'webapp/test/unit/Main.qunit.js');
      seed(root, 'webapp/test/_failing/Broken.failing.qunit.js');
      const scope = await resolveFileScope({ projectRoot: root, all: true });
      const rels = scope.qunitTest.map((p) => p.replace(/\\/g, '/'));
      expect(rels.some((p) => p.endsWith('webapp/test/unit/Main.qunit.js'))).toBe(true);
      expect(rels.some((p) => p.includes('/test/_failing/'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
