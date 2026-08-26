import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildProjectGraph } from '../../src/project/dependency-graph.js';
import { detectTestLayout } from '../../src/project/test-layout.js';
import { isCoreBundledNamespace } from '../../src/project/karma-ui5-defaults.js';

/**
 * V1.4-3 witnesses — pin `buildProjectGraph`'s contract before
 * V1.4-4 implements it. The identity stub returns the empty-graph
 * sentinel for every input, so cases that EXPECT real population
 * (manifestLibs / controllers / unpreloadedLibs) fail with specific
 * assertion mismatches against `[]` until V1.4-4 lands the builder.
 *
 * The `empty project` case is the only one that incidentally passes
 * against the stub (empty in, empty out); kept here as the boundary
 * witness.
 */

interface SeedArgs {
  readonly manifest?: object | null;
  readonly karmaConf?: string | null;
  readonly controllers?: ReadonlyArray<{ readonly rel: string; readonly content: string }>;
}

function seedProject(args: SeedArgs): string {
  const root = mkdtempSync(join(tmpdir(), 'sapui5-v1.4-graph-'));
  mkdirSync(join(root, 'webapp'), { recursive: true });
  if (args.manifest !== undefined) {
    if (args.manifest === null) {
      writeFileSync(join(root, 'webapp', 'manifest.json'), '{ not valid json');
    } else {
      writeFileSync(
        join(root, 'webapp', 'manifest.json'),
        JSON.stringify(args.manifest, null, 2),
      );
    }
  }
  if (args.karmaConf !== undefined && args.karmaConf !== null) {
    writeFileSync(join(root, 'karma.conf.js'), args.karmaConf);
  }
  for (const c of args.controllers ?? []) {
    const abs = join(root, c.rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, c.content);
  }
  return root;
}

const TEMP_ROOTS: string[] = [];
beforeEach(() => {
  TEMP_ROOTS.length = 0;
});
afterEach(() => {
  for (const r of TEMP_ROOTS) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeProject(args: SeedArgs): string {
  const root = seedProject(args);
  TEMP_ROOTS.push(root);
  return root;
}

describe('buildProjectGraph', () => {
  test('empty project (no controllers, no manifest, no karma) — empty graph', async () => {
    const root = makeProject({});
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.controllers).toEqual([]);
    expect(graph.manifestLibs).toEqual([]);
    expect(graph.karmaClientLibs).toEqual([]);
    expect(graph.unpreloadedLibs).toEqual([]);
    // V1.4-8 — no manifest → namespace unknown.
    expect(graph.projectNamespace).toBeNull();
  });

  test('all imports declared in manifest — no gap', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Main.controller.js',
          content: 'sap.ui.define(["sap/m/Button","sap/ui/core/mvc/Controller"], function(){});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.manifestLibs).toEqual(expect.arrayContaining(['sap.m', 'sap.ui.core']));
    expect(graph.unpreloadedLibs).toEqual([]);
  });

  test('cap_try-shape gap — controller imports sap/ui/export but manifest only declares sap.m + sap.ui.core', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'cap_try', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: [
            'sap.ui.define([',
            '  "cap_try/controller/BaseController",',
            '  "sap/ui/export/Spreadsheet"',
            '], function (BaseController, Spreadsheet) { return BaseController.extend("Reports", {}); });',
          ].join('\n'),
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.unpreloadedLibs).toHaveLength(1);
    const gap = graph.unpreloadedLibs[0];
    expect(gap?.lib).toBe('sap.ui.export');
    expect(gap?.importedBy).toEqual(['webapp/controller/Reports.controller.js']);
    expect(gap?.suggestedFix).toBe('manifest');
    // V1.4-8 — sap.app.id surfaces as the project namespace, and the
    // project-local import (cap_try/controller/BaseController) is excluded
    // from the gap (only sap.ui.export remains).
    expect(graph.projectNamespace).toBe('cap_try');
    // V1.4-10 — no karma.conf ui5.url in this fixture and no injected
    // probe, so the gap defaults to cdnServed: true (preload-fixable).
    // R2.4 — and cdnProbed: false records that this is only the default,
    // not a probe-confirmed fact (feeds the offline auto-apply guard).
    expect(graph.unpreloadedLibs[0]?.cdnServed).toBe(true);
    expect(graph.unpreloadedLibs[0]?.cdnProbed).toBe(false);
  });

  test('V1.4-10 — injected probe returning false marks the gap cdnServed: false (stub-only)', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'cap_try', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: 'sap.ui.define(["sap/ui/export/Spreadsheet"], function () {});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({
      projectRoot: root,
      testLayout: layout,
      probeLib: async () => false,
    });
    expect(graph.unpreloadedLibs).toHaveLength(1);
    expect(graph.unpreloadedLibs[0]?.lib).toBe('sap.ui.export');
    expect(graph.unpreloadedLibs[0]?.cdnServed).toBe(false);
    // R2.4 — the probe answered, so the gap is probe-confirmed.
    expect(graph.unpreloadedLibs[0]?.cdnProbed).toBe(true);
  });

  test('V1.4-10 — injected probe returning true keeps the gap cdnServed: true (manifest-fixable)', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'cap_try', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: 'sap.ui.define(["sap/f/library"], function () {});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({
      projectRoot: root,
      testLayout: layout,
      probeLib: async () => true,
    });
    expect(graph.unpreloadedLibs).toHaveLength(1);
    expect(graph.unpreloadedLibs[0]?.cdnServed).toBe(true);
    expect(graph.unpreloadedLibs[0]?.cdnProbed).toBe(true);
  });

  test('R2.4 — a THROWING probe keeps the conservative cdnServed: true but counts as un-probed', async () => {
    // A network blip must never force the stub path (V1.4-10 contract), but
    // it is also not a confirmation: cdnProbed stays false so the offline
    // auto-apply guard treats the namespace as unverified.
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'cap_try', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: 'sap.ui.define(["sap/ui/export/Spreadsheet"], function () {});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({
      projectRoot: root,
      testLayout: layout,
      probeLib: async () => {
        throw new Error('ENOTFOUND sdk.openui5.org');
      },
    });
    expect(graph.unpreloadedLibs).toHaveLength(1);
    expect(graph.unpreloadedLibs[0]?.cdnServed).toBe(true);
    expect(graph.unpreloadedLibs[0]?.cdnProbed).toBe(false);
  });

  test('SEC-2 — an SSRF-shaped karma ui5.url is refused offline and records cdnProbed: false', async () => {
    // The CDN probe target comes from the untrusted karma.conf.js. A
    // metadata/loopback/private ui5.url must be refused by the SEC-2 guard
    // BEFORE any network call; buildProjectGraph maps that refusal to the
    // conservative unprobed default (cdnServed: true, cdnProbed: false). No
    // probe is injected here, so this exercises the real probeLibServed →
    // assertSafeProbeUrl path and stays fully offline (the guard throws before
    // fetch is ever reached).
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'cap_try', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      karmaConf: [
        'module.exports = function(config){',
        '  config.set({',
        '    ui5: { url: "http://169.254.169.254" }',
        '  });',
        '};',
      ].join('\n'),
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: 'sap.ui.define(["sap/ui/export/Spreadsheet"], function () {});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.unpreloadedLibs).toHaveLength(1);
    expect(graph.unpreloadedLibs[0]?.lib).toBe('sap.ui.export');
    expect(graph.unpreloadedLibs[0]?.cdnServed).toBe(true);
    expect(graph.unpreloadedLibs[0]?.cdnProbed).toBe(false);
  });

  test('V1.4-9 / V1.9.1-D3 — core-bundled namespaces (sap.ui.model / sap.base / sap.ui.base / sap.ui Device + deep sap/base/* descendants) are NOT false-positive gaps', async () => {
    // These derive via libNameFor to sap.ui.model / sap.base / sap.ui.base /
    // sap.ui but ship inside sap.ui.core; with only sap.m + sap.ui.core
    // declared they load fine (cap_try first-run evidence), so the gap
    // must stay empty.
    //
    // V1.9.1 (D3) — sap/base/i18n/ResourceBundle and sap/base/strings/* hit the
    // libNameFor 3-segment cap and derive sap.base.i18n / sap.base.strings
    // (descendants of the core-bundled sap.base, NOT in the flat exclusion set).
    // The old exact-membership exclusion missed them → false-positive gap on a
    // real TS project (cap_try_ts surfaced sap.base.i18n). The prefix-aware
    // isCoreBundledNamespace must absorb these descendants too.
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Base.controller.js',
          content: [
            'sap.ui.define([',
            '  "sap/ui/core/mvc/Controller",',
            '  "sap/ui/model/Filter",',
            '  "sap/ui/model/json/JSONModel",',
            '  "sap/ui/base/Object",',
            '  "sap/base/Log",',
            '  "sap/base/i18n/ResourceBundle",',
            '  "sap/base/strings/formatMessage",',
            '  "sap/ui/Device"',
            '], function () {});',
          ].join('\n'),
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.unpreloadedLibs).toEqual([]);
  });

  test('V1.4-9 / V1.9.1-D3 — a genuine library gap is still flagged alongside core-bundled imports (sap.ui carve-out guard)', async () => {
    // Reports-shape: real gaps (sap.ui.export, sap.f) must survive even when
    // the controller also imports core-bundled namespaces.
    //
    // V1.9.1 (D3) carve-out guard — sap/ui/table/Table derives sap.ui.table, a
    // child of sap.ui. sap.ui is the ONE core-bundled entry that prefixes real
    // preloadable libraries (sap.ui.table / sap.ui.layout / sap.ui.comp /
    // sap.ui.export / sap.ui.unified), so isCoreBundledNamespace must treat
    // sap.ui as EXACT-only. This test fails if the fix wrongly makes sap.ui
    // prefix-match (which would silently mask the sap.ui.table gap).
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'cap_try', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: [
            'sap.ui.define([',
            '  "sap/ui/model/Filter",',
            '  "sap/f/library",',
            '  "sap/ui/export/Spreadsheet",',
            '  "sap/ui/table/Table"',
            '], function () {});',
          ].join('\n'),
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    const gapLibs = graph.unpreloadedLibs.map((g) => g.lib).sort();
    expect(gapLibs).toEqual(['sap.f', 'sap.ui.export', 'sap.ui.table']);
  });

  test('gap covered by client.libs override — no gap', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      karmaConf: [
        'module.exports = function(config){',
        '  config.set({',
        '    client: { libs: ["sap.ui.export"] }',
        '  });',
        '};',
      ].join('\n'),
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: 'sap.ui.define(["sap/ui/export/Spreadsheet"], function(){});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.karmaClientLibs).toEqual(['sap.ui.export']);
    expect(graph.unpreloadedLibs).toEqual([]);
  });

  test('multiple controllers, one shared gap — importedBy carries both paths in document order', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Reports.controller.js',
          content: 'sap.ui.define(["sap/ui/export/Spreadsheet"], function(){});',
        },
        {
          rel: 'webapp/controller/Settings.controller.js',
          content: 'sap.ui.define(["sap/ui/export/Spreadsheet"], function(){});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.unpreloadedLibs).toHaveLength(1);
    const gap = graph.unpreloadedLibs[0];
    expect(gap?.lib).toBe('sap.ui.export');
    expect(gap?.importedBy).toEqual([
      'webapp/controller/Reports.controller.js',
      'webapp/controller/Settings.controller.js',
    ]);
  });

  test('always-available subset — sap/ui/thirdparty/sinon does not appear as a gap', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/test/unit/controller/Main.qunit.js',
          content: 'sap.ui.define(["sap/ui/thirdparty/sinon"], function(){});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.unpreloadedLibs).toEqual([]);
  });

  test('lib-namespace derivation parity with V1.3.3-5 libNameFor — 3-segment cap', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {}, 'sap.ui.core': {} } } },
      },
      controllers: [
        {
          rel: 'webapp/controller/Smart.controller.js',
          content: 'sap.ui.define(["sap/ui/comp/smartfield/SmartField"], function(){});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.controllers).toHaveLength(1);
    expect(graph.controllers[0]?.libNamespaces).toEqual(['sap.ui.comp']);
    expect(graph.unpreloadedLibs).toHaveLength(1);
    expect(graph.unpreloadedLibs[0]?.lib).toBe('sap.ui.comp');
  });

  test('malformed controller (empty file) — degrades to imports: []', async () => {
    const root = makeProject({
      manifest: {
        'sap.app': { id: 'demo', type: 'application' },
        'sap.ui5': { dependencies: { libs: { 'sap.m': {} } } },
      },
      controllers: [{ rel: 'webapp/controller/Broken.controller.js', content: '' }],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.controllers).toHaveLength(1);
    expect(graph.controllers[0]?.imports).toEqual([]);
    expect(graph.unpreloadedLibs).toEqual([]);
  });

  test('malformed manifest (invalid JSON) — degrades to manifestLibs: []', async () => {
    const root = makeProject({
      manifest: null,
      controllers: [
        {
          rel: 'webapp/controller/Main.controller.js',
          content: 'sap.ui.define(["sap/m/Button"], function(){});',
        },
      ],
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.manifestLibs).toEqual([]);
  });

  test('karma.conf.js absent — karmaClientLibs: []', async () => {
    const root = makeProject({
      manifest: { 'sap.app': { id: 'demo', type: 'application' }, 'sap.ui5': {} },
    });
    const layout = detectTestLayout(root);
    const graph = await buildProjectGraph({ projectRoot: root, testLayout: layout });

    expect(graph.karmaClientLibs).toEqual([]);
  });
});

describe('isCoreBundledNamespace (V1.9.1-D3)', () => {
  // Prefix-aware exclusion: a dotted descendant of a core-bundled namespace is
  // itself core-bundled — EXCEPT sap.ui, which prefixes real preloadable
  // libraries and is therefore exact-only. The carve-out is what keeps
  // sap.ui.table / sap.ui.export / sap.f flaggable as genuine gaps.
  test.each([
    // descendants of core-bundled namespaces → excluded (true)
    ['sap.base.i18n', true], // the cap_try_ts false positive (libNameFor over-shoot of sap/base/i18n/*)
    ['sap.base', true], // exact set member
    ['sap.ui.model.odata', true], // deep descendant of core-bundled sap.ui.model
    ['sap.ui', true], // exact set member (bootstrap namespace)
    // sap.ui is EXACT-only → its real-library children stay flaggable (false)
    ['sap.ui.table', false],
    ['sap.ui.export', false],
    ['sap.f', false], // unrelated real library
  ])('isCoreBundledNamespace(%j) === %j', (lib, expected) => {
    expect(isCoreBundledNamespace(lib)).toBe(expected);
  });
});
