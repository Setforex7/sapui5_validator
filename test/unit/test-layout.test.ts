import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  FALLBACK_LAYOUT,
  detectTestLayout,
  parseKarmaClientLibs,
  parseKarmaConfig,
  parseKarmaUi5Url,
  parseTestSuiteHtml,
  resolveQUnitRoot,
  type TestLayout,
} from '../../src/project/test-layout.js';

const FIX_ROOT = join(process.cwd(), 'test', 'fixtures');

describe('parseKarmaConfig — minimal-project fixture', () => {
  test('extracts the two qunit globs from a real karma.conf.js', () => {
    const result = parseKarmaConfig(join(FIX_ROOT, 'minimal-project'));
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.path.endsWith('karma.conf.js')).toBe(true);
    expect(result.testFileGlobs).toContain('webapp/test/unit/**/*.qunit.js');
    expect(result.testFileGlobs).toContain('webapp/test/integration/**/*.qunit.js');
  });

  test('returns undefined when no karma config exists', () => {
    const result = parseKarmaConfig(join(FIX_ROOT, 'no-tests-project'));
    expect(result).toBeUndefined();
  });
});

describe('parseTestSuiteHtml — minimal-project fixture', () => {
  test('captures both <a href="..."> entries', () => {
    const result = parseTestSuiteHtml(join(FIX_ROOT, 'minimal-project'));
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.entries).toContain('unit/unit.qunit.html');
    expect(result.entries).toContain('integration/opaTests.qunit.html');
  });

  test('returns undefined when testsuite.qunit.html is absent', () => {
    const result = parseTestSuiteHtml(join(FIX_ROOT, 'no-tests-project'));
    expect(result).toBeUndefined();
  });
});

describe('detectTestLayout', () => {
  test('minimal-project resolves via config', () => {
    const layout = detectTestLayout(join(FIX_ROOT, 'minimal-project'));
    expect(layout.inferredFrom).toBe('config');
    expect(layout.karma).toBeDefined();
    expect(layout.testsuite).toBeDefined();
    expect(layout.fallback).toEqual(FALLBACK_LAYOUT);
  });

  test('no-tests-project falls back to standard SAPUI5 layout', () => {
    const layout = detectTestLayout(join(FIX_ROOT, 'no-tests-project'));
    expect(layout.inferredFrom).toBe('fallback');
    expect(layout.karma).toBeUndefined();
    expect(layout.testsuite).toBeUndefined();
    expect(layout.fallback.qunit).toBe('webapp/test/unit');
    expect(layout.fallback.opa5).toBe('webapp/test/integration');
  });
});

describe('resolveQUnitRoot', () => {
  test('returns the karma-derived root when a unit glob is present', () => {
    const layout: TestLayout = {
      inferredFrom: 'config',
      fallback: FALLBACK_LAYOUT,
      karma: {
        path: '/abs/karma.conf.js',
        testFileGlobs: [
          'webapp/test/unit/**/*.qunit.js',
          'webapp/test/integration/**/*.qunit.js',
        ],
      },
    };
    expect(resolveQUnitRoot(layout)).toBe('webapp/test/unit');
  });

  test('falls back to layout.fallback.qunit when no karma globs are usable', () => {
    const layout: TestLayout = {
      inferredFrom: 'fallback',
      fallback: FALLBACK_LAYOUT,
    };
    expect(resolveQUnitRoot(layout)).toBe(FALLBACK_LAYOUT.qunit);
  });

  test('returns a non-standard root when karma points elsewhere', () => {
    const layout: TestLayout = {
      inferredFrom: 'config',
      fallback: FALLBACK_LAYOUT,
      karma: {
        path: '/abs/karma.conf.js',
        testFileGlobs: ['custom/qunit/**/*.qunit.js'],
      },
    };
    expect(resolveQUnitRoot(layout)).toBe('custom/qunit');
  });

  test('GA1-08 — resolves a root from a `.qunit.ts` glob (TS karma config)', () => {
    // Fail-on-revert: the pre-V1.9 `.qunit.js`-only literal skipped a TS glob and
    // returned the fallback `webapp/test/unit`; the resolved root would then be
    // wrong for any TS project whose tests live elsewhere.
    const layout: TestLayout = {
      inferredFrom: 'config',
      fallback: FALLBACK_LAYOUT,
      karma: {
        path: '/abs/karma.conf.ts',
        testFileGlobs: ['webapp/qunit/**/*.qunit.ts'],
      },
    };
    expect(resolveQUnitRoot(layout)).toBe('webapp/qunit');
    expect(resolveQUnitRoot(layout)).not.toBe(FALLBACK_LAYOUT.qunit);
  });
});

describe('parseKarmaConfig — tolerant regex on synthetic configs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-layout-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('plain string-only files: array', () => {
    writeFileSync(
      join(root, 'karma.conf.js'),
      `module.exports = function (config) {
        config.set({
          files: [
            'webapp/test/unit/**/*.qunit.js',
            "webapp/test/integration/**/*.qunit.js"
          ]
        });
      };
      `,
    );
    const result = parseKarmaConfig(root);
    expect(result?.testFileGlobs).toEqual([
      'webapp/test/unit/**/*.qunit.js',
      'webapp/test/integration/**/*.qunit.js',
    ]);
  });

  test('object-shaped { pattern: ... } entries are extracted', () => {
    writeFileSync(
      join(root, 'karma.conf.js'),
      `module.exports = function (config) {
        config.set({
          files: [
            { pattern: 'webapp/test/unit/**/*.qunit.js', included: false },
            { pattern: 'webapp/test/integration/**/*.qunit.js', included: false }
          ]
        });
      };
      `,
    );
    const result = parseKarmaConfig(root);
    expect(result?.testFileGlobs).toEqual([
      'webapp/test/unit/**/*.qunit.js',
      'webapp/test/integration/**/*.qunit.js',
    ]);
  });

  test('karma.conf.ts is also picked up', () => {
    writeFileSync(
      join(root, 'karma.conf.ts'),
      `export default (config: any) => { config.set({ files: ['x.qunit.js'] }); };`,
    );
    const result = parseKarmaConfig(root);
    expect(result?.path.endsWith('karma.conf.ts')).toBe(true);
    expect(result?.testFileGlobs).toEqual(['x.qunit.js']);
  });

  test('config with no files: [...] block returns empty globs (not undefined)', () => {
    writeFileSync(
      join(root, 'karma.conf.js'),
      `module.exports = function (config) { config.set({ frameworks: ['ui5'] }); };`,
    );
    const result = parseKarmaConfig(root);
    expect(result).toBeDefined();
    expect(result?.testFileGlobs).toEqual([]);
  });
});

/**
 * V1.4-3 witnesses — pin `parseKarmaClientLibs`'s contract before
 * V1.4-4 implements it. The identity stub returns `[]` for every
 * input, so cases asserting populated arrays fail with specific
 * assertion mismatches against `[]` until V1.4-4 lands the tolerant
 * regex.
 */
describe('parseKarmaClientLibs', () => {
  test('client.libs explicitly set — extracts the array', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      "    client: { libs: ['sap.m', 'sap.ui.export'] }",
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaClientLibs(content)).toEqual(['sap.m', 'sap.ui.export']);
  });

  test('client without libs — returns empty', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({ client: { logErrors: true } });',
      '};',
    ].join('\n');
    expect(parseKarmaClientLibs(content)).toEqual([]);
  });

  test('no client block — returns empty', () => {
    const content =
      "module.exports = function (config) { config.set({ frameworks: ['ui5'] }); };";
    expect(parseKarmaClientLibs(content)).toEqual([]);
  });

  test('multi-line libs array — extracts entries across newlines', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      '    client: {',
      '      libs: [',
      '        "sap.m",',
      '        "sap.ui.export"',
      '      ]',
      '    }',
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaClientLibs(content)).toEqual(['sap.m', 'sap.ui.export']);
  });

  test('AH2 — commented-out client.libs is ignored', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      "    // client: { libs: ['sap.m'] }",
      "    frameworks: ['ui5']",
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaClientLibs(content)).toEqual([]);
  });

  test('COR-10 — a sibling object before libs no longer hides it (brace-balanced)', () => {
    // Pre-COR-10 the flat `[^{}]*` between `client:` and `libs:` rejected the
    // inner `{ ... }` and returned [], masking a real lib override.
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      "    client: { ui5: { config: { async: true } }, libs: ['sap.m', 'sap.f'] }",
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaClientLibs(content)).toEqual(['sap.m', 'sap.f']);
  });

  test('COR-10 — a `libs` nested in a sibling object is skipped; only the top-level libs is read', () => {
    // Non-vacuous: the OLD `[^{}]*` regex cannot cross the `{` of `other: {` to
    // reach EITHER libs, so it returned [] for this shape. The balanced scan
    // skips the nested decoy and reads ONLY the top-level `libs` → ['real'].
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      "    client: { other: { libs: ['sap.decoy'] }, libs: ['sap.real'] }",
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaClientLibs(content)).toEqual(['sap.real']);
  });
});

/**
 * V1.4-10 witnesses — pin `parseKarmaUi5Url`'s contract: it feeds the
 * CDN-availability probe that distinguishes a manifest-fixable gap from a
 * stub-only one.
 */
describe('parseKarmaUi5Url', () => {
  test('extracts the ui5.url value (double quotes)', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      '    frameworks: ["ui5"],',
      '    ui5: { url: "https://sdk.openui5.org" }',
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaUi5Url(content)).toBe('https://sdk.openui5.org');
  });

  test('extracts the ui5.url value (single quotes, multi-line)', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      '    ui5: {',
      "      url: 'https://sapui5.hana.ondemand.com'",
      '    }',
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaUi5Url(content)).toBe('https://sapui5.hana.ondemand.com');
  });

  test('no ui5 block — returns null', () => {
    const content =
      "module.exports = function (config) { config.set({ frameworks: ['ui5'] }); };";
    expect(parseKarmaUi5Url(content)).toBeNull();
  });

  test('ui5 block without url — returns null', () => {
    const content =
      'module.exports = function (config) { config.set({ ui5: { type: "library" } }); };';
    expect(parseKarmaUi5Url(content)).toBeNull();
  });

  test('commented-out ui5.url is ignored', () => {
    const content = [
      'module.exports = function (config) {',
      '  config.set({',
      '    // ui5: { url: "https://sdk.openui5.org" }',
      "    frameworks: ['ui5']",
      '  });',
      '};',
    ].join('\n');
    expect(parseKarmaUi5Url(content)).toBeNull();
  });
});

describe('parseKarmaConfig — F4: comment/char-class files array fidelity', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'v15-f4-'));
  });

  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  test('balance-scans the files: array past a comment ] and a char-class glob', () => {
    // The old non-greedy `[\s\S]*?]` stopped at the first `]` (inside the
    // `[unit]` char class), dropping the later globs and degrading
    // resolveQUnitRoot to the SPEC §2.7 fallback. The balance-scan keeps both.
    const conf = [
      'module.exports = function (config) {',
      '  config.set({',
      '    files: [',
      "      'webapp/test/[unit]/**/*.qunit.js', // covers [both]",
      "      'webapp/test/integration/**/*.qunit.js'",
      '    ],',
      '  });',
      '};',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'karma.conf.js'), conf, 'utf8');

    const result = parseKarmaConfig(dir);
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.testFileGlobs).toContain('webapp/test/[unit]/**/*.qunit.js');
    expect(result.testFileGlobs).toContain('webapp/test/integration/**/*.qunit.js');
    expect(result.testFileGlobs).toHaveLength(2); // the comment is not captured as a glob
  });
});

describe('parseTestSuiteHtml — synthetic cases', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-html-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('extracts hrefs regardless of attribute order or quote style', () => {
    mkdirSync(join(root, 'webapp', 'test'), { recursive: true });
    writeFileSync(
      join(root, 'webapp', 'test', 'testsuite.qunit.html'),
      `<html><body>
        <a class="x" href='unit/unit.qunit.html'>Unit</a>
        <a target="_blank" href="integration/opaTests.qunit.html">Integration</a>
      </body></html>`,
    );
    const result = parseTestSuiteHtml(root);
    expect(result?.entries).toEqual([
      'unit/unit.qunit.html',
      'integration/opaTests.qunit.html',
    ]);
  });

  test('returns empty entries when document has no anchors', () => {
    mkdirSync(join(root, 'webapp', 'test'), { recursive: true });
    writeFileSync(
      join(root, 'webapp', 'test', 'testsuite.qunit.html'),
      '<html><body>no links here</body></html>',
    );
    const result = parseTestSuiteHtml(root);
    expect(result).toBeDefined();
    expect(result?.entries).toEqual([]);
  });
});
