import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findOpa5Candidates } from '../../src/generation/opa5.js';
import { detectTestLayout } from '../../src/project/test-layout.js';

function seed(root: string, rel: string, content = ''): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

const VIEW_XML_FOR = (ctlrDot: string): string =>
  `<mvc:View controllerName="${ctlrDot}" xmlns:mvc="sap.ui.core.mvc"><Button text="x"/></mvc:View>`;

describe('findOpa5Candidates', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-opa-disc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('pairs view + controller and proposes a Journey path', () => {
    const viewAbs = seed(
      root,
      'webapp/view/Main.view.xml',
      VIEW_XML_FOR('demo.app.controller.Main'),
    );
    seed(root, 'webapp/controller/Main.controller.js', '// Main');
    const layout = detectTestLayout(root);
    const cands = findOpa5Candidates({
      projectRoot: root,
      views: [viewAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.viewName).toBe('Main');
    expect(cands[0]?.controllerRel).toBe('webapp/controller/Main.controller.js');
    expect(cands[0]?.journeyTestRel).toBe(
      'webapp/test/integration/MainJourney.qunit.js',
    );
  });

  test('COR-6: a `controller`-named namespace segment still resolves the pair', () => {
    // Pre-COR-6 OPA5 sliced from the FIRST `controller` segment, so a namespace
    // literally containing `controller` produced a wrong path and the candidate
    // was dropped. The shared resolver uses the last `controller` segment.
    const viewAbs = seed(
      root,
      'webapp/view/Main.view.xml',
      VIEW_XML_FOR('my.controller.app.controller.Main'),
    );
    seed(root, 'webapp/controller/Main.controller.js', '// Main');
    const layout = detectTestLayout(root);
    const cands = findOpa5Candidates({ projectRoot: root, views: [viewAbs], testLayout: layout });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.controllerRel).toBe('webapp/controller/Main.controller.js');
  });

  test('skips views with no controllerName attribute', () => {
    const viewAbs = seed(
      root,
      'webapp/view/Naked.view.xml',
      '<mvc:View xmlns:mvc="sap.ui.core.mvc"></mvc:View>',
    );
    const layout = detectTestLayout(root);
    const cands = findOpa5Candidates({
      projectRoot: root,
      views: [viewAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(0);
  });

  test('skips when controller file does not exist', () => {
    const viewAbs = seed(
      root,
      'webapp/view/Missing.view.xml',
      VIEW_XML_FOR('demo.app.controller.NotThere'),
    );
    const layout = detectTestLayout(root);
    const cands = findOpa5Candidates({
      projectRoot: root,
      views: [viewAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(0);
  });

  test('skips when a journey file already exists', () => {
    const viewAbs = seed(
      root,
      'webapp/view/Main.view.xml',
      VIEW_XML_FOR('demo.app.controller.Main'),
    );
    seed(root, 'webapp/controller/Main.controller.js', '// Main');
    seed(root, 'webapp/test/integration/MainJourney.qunit.js', '// already here');
    const layout = detectTestLayout(root);
    const cands = findOpa5Candidates({
      projectRoot: root,
      views: [viewAbs],
      testLayout: layout,
    });
    expect(cands).toHaveLength(0);
  });
});
