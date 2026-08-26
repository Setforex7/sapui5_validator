import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findQunitCandidates } from '../../src/generation/qunit.js';
import { detectTestLayout } from '../../src/project/test-layout.js';

function seed(root: string, rel: string, content = ''): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('findQunitCandidates', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-qunit-disc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns controllers without an existing .qunit.js test', () => {
    const controllerAbs = seed(root, 'webapp/controller/App.controller.js', '// App');
    const layout = detectTestLayout(root);
    const cands = findQunitCandidates({
      projectRoot: root,
      controllers: [controllerAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.controllerRel).toBe('webapp/controller/App.controller.js');
    expect(cands[0]?.expectedTestRel).toBe(
      'webapp/test/unit/controller/App.controller.qunit.js',
    );
  });

  test('skips controllers that already have a test', () => {
    const controllerAbs = seed(root, 'webapp/controller/App.controller.js', '// App');
    seed(
      root,
      'webapp/test/unit/controller/App.controller.qunit.js',
      'QUnit.module("App");',
    );
    const layout = detectTestLayout(root);
    const cands = findQunitCandidates({
      projectRoot: root,
      controllers: [controllerAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(0);
  });

  test('honours karma config glob for the test root', () => {
    const controllerAbs = seed(root, 'webapp/controller/Foo.controller.js', '// Foo');
    // karma config pointing at a non-standard root.
    seed(
      root,
      'karma.conf.js',
      `module.exports = function (c) { c.set({ files: [{ pattern: 'webapp/qunit/**/*.qunit.js' }] }); };`,
    );
    const layout = detectTestLayout(root);
    const cands = findQunitCandidates({
      projectRoot: root,
      controllers: [controllerAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.expectedTestRel).toBe(
      'webapp/qunit/controller/Foo.controller.qunit.js',
    );
  });
});
