/**
 * V1.3-4 — unit coverage for `src/generation/registration.ts`.
 *
 * Covers module-id computation, `detectDiscoveryMode` (all four modes plus the
 * overlap precedence rule), and idempotent `registerTest` / `unregisterTest`
 * for every handled mode — including the awkward array shapes: an empty array,
 * a single-entry array, and removing the last remaining entry.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  computeModuleId,
  detectDiscoveryMode,
  registerTest,
  unregisterTest,
  type RegistrationRequest,
} from '../../src/generation/registration.js';
import { findMatchingDelimiter } from '../../src/util/balance-scan.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sapui5-reg-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TESTSUITE_REL = join('webapp', 'test', 'testsuite.qunit.html');

/** Write a `sap.ui.require([...])` testsuite.qunit.html with the given module ids. */
function writeTestsuite(moduleIds: readonly string[]): void {
  const inner =
    moduleIds.length === 0
      ? ''
      : `\n${moduleIds.map((id) => `      "${id}"`).join(',\n')}\n    `;
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <script>',
    '    QUnit.config.autostart = false;',
    `    sap.ui.require([${inner}], function () {`,
    '      QUnit.start();',
    '    });',
    '  </script>',
    '</head>',
    '<body></body>',
    '</html>',
    '',
  ].join('\n');
  mkdirSync(join(root, 'webapp', 'test'), { recursive: true });
  writeFileSync(join(root, TESTSUITE_REL), html, 'utf8');
}

/** Write a karma.conf.js whose `files:` array holds the given literals. */
function writeKarma(fileEntries: readonly string[]): void {
  const inner = fileEntries.map((f) => `      '${f}'`).join(',\n');
  const conf = [
    'module.exports = function (config) {',
    '  config.set({',
    "    frameworks: ['ui5'],",
    '    files: [',
    inner,
    '    ],',
    '  });',
    '};',
    '',
  ].join('\n');
  writeFileSync(join(root, 'karma.conf.js'), conf, 'utf8');
}

function readTestsuite(): string {
  return readFileSync(join(root, TESTSUITE_REL), 'utf8');
}

function readKarma(): string {
  return readFileSync(join(root, 'karma.conf.js'), 'utf8');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function req(over: Partial<RegistrationRequest>): RegistrationRequest {
  return {
    projectRoot: root,
    mode: 'testsuite-require',
    moduleId: 'demo/test/unit/controller/X.controller.qunit',
    testFileRel: 'webapp/test/unit/controller/X.controller.qunit.js',
    ...over,
  };
}

describe('computeModuleId', () => {
  test('dotted namespace + webapp-relative test path → slash module id', () => {
    expect(
      computeModuleId({
        namespace: 'e2e.real.project',
        fileRel: 'webapp/test/unit/controller/App.controller.qunit.js',
      }),
    ).toBe('e2e/real/project/test/unit/controller/App.controller.qunit');
  });

  test('tolerates a single-segment namespace and Windows separators', () => {
    expect(
      computeModuleId({
        namespace: 'app',
        fileRel: 'webapp\\test\\unit\\Main.controller.qunit.js',
      }),
    ).toBe('app/test/unit/Main.controller.qunit');
  });

  // V1.9.2 (TG-MODULEID / FS-5) — a TS controller's id is its ES default-import
  // specifier, so the trailing `.ts` MUST be stripped exactly as `.js` is.
  // Fail-on-revert: restore the `/\.js$/u`-only strip and these go red (the id
  // keeps a dangling `.ts`, pointing the import at a non-existent module).
  test('strips a trailing .ts so a TS controller id is its ES import specifier', () => {
    expect(
      computeModuleId({
        namespace: 'e2e.real.ts',
        fileRel: 'webapp/controller/App.controller.ts',
      }),
    ).toBe('e2e/real/ts/controller/App.controller');
  });

  test('strips a trailing .ts from a generated .qunit.ts test path', () => {
    expect(
      computeModuleId({
        namespace: 'e2e.real.ts',
        fileRel: 'webapp/test/unit/controller/App.controller.qunit.ts',
      }),
    ).toBe('e2e/real/ts/test/unit/controller/App.controller.qunit');
  });

  test('a .ts strip does not over-trim a non-extension .ts substring', () => {
    // Only the trailing extension is rewritten — an interior `ts` is untouched.
    expect(
      computeModuleId({ namespace: 'app', fileRel: 'webapp/controller/Lights.controller.ts' }),
    ).toBe('app/controller/Lights.controller');
  });
});

describe('detectDiscoveryMode', () => {
  test('testsuite.qunit.html with a sap.ui.require array → testsuite-require', () => {
    writeTestsuite(['demo/test/unit/Main.controller.qunit']);
    expect(detectDiscoveryMode(root)).toBe('testsuite-require');
  });

  test('karma files: array of explicit .qunit.js literals → karma-files-glob', () => {
    writeKarma(['webapp/test/unit/Main.controller.qunit.js']);
    expect(detectDiscoveryMode(root)).toBe('karma-files-glob');
  });

  test('karma files: array with a wildcard glob → glob-auto', () => {
    writeKarma(['webapp/test/unit/**/*.qunit.js']);
    expect(detectDiscoveryMode(root)).toBe('glob-auto');
  });

  test('neither signal present → unknown', () => {
    expect(detectDiscoveryMode(root)).toBe('unknown');
  });

  test('precedence: a sap.ui.require testsuite outranks a karma files: list', () => {
    writeTestsuite(['demo/test/unit/Main.controller.qunit']);
    writeKarma(['webapp/test/unit/Main.controller.qunit.js']);
    expect(detectDiscoveryMode(root)).toBe('testsuite-require');
  });
});

describe('registerTest / unregisterTest — testsuite-require', () => {
  const NEW = 'demo/test/unit/controller/App.controller.qunit';
  const EXISTING = 'demo/test/unit/controller/Main.controller.qunit';

  test('register inserts the module and preserves the existing entry', async () => {
    writeTestsuite([EXISTING]);
    await registerTest(req({ moduleId: NEW }));
    const html = readTestsuite();
    expect(html).toContain(NEW);
    expect(html).toContain(EXISTING);
    // Still parseable: re-detection succeeds.
    expect(detectDiscoveryMode(root)).toBe('testsuite-require');
  });

  test('register is idempotent — registering twice yields a single entry', async () => {
    writeTestsuite([EXISTING]);
    await registerTest(req({ moduleId: NEW }));
    await registerTest(req({ moduleId: NEW }));
    expect(occurrences(readTestsuite(), NEW)).toBe(1);
  });

  test('unregister removes the module and leaves the others intact', async () => {
    writeTestsuite([EXISTING, NEW]);
    await unregisterTest(req({ moduleId: NEW }));
    const html = readTestsuite();
    expect(html).not.toContain(NEW);
    expect(html).toContain(EXISTING);
  });

  test('unregister is idempotent — removing an absent module is a no-op', async () => {
    writeTestsuite([EXISTING]);
    const before = readTestsuite();
    await unregisterTest(req({ moduleId: NEW }));
    expect(readTestsuite()).toBe(before);
  });

  test('inserts into an empty sap.ui.require([]) array', async () => {
    writeTestsuite([]);
    await registerTest(req({ moduleId: NEW }));
    expect(readTestsuite()).toContain(NEW);
    expect(detectDiscoveryMode(root)).toBe('testsuite-require');
  });

  test('removing the last entry leaves a valid empty array', async () => {
    writeTestsuite([NEW]);
    await unregisterTest(req({ moduleId: NEW }));
    const html = readTestsuite();
    expect(html).not.toContain(NEW);
    expect(html).toContain('sap.ui.require([]');
    // The emptied array is still a valid registration target.
    await registerTest(req({ moduleId: EXISTING }));
    expect(readTestsuite()).toContain(EXISTING);
  });

  test('register → unregister round-trip restores a single-module suite', async () => {
    writeTestsuite([EXISTING]);
    await registerTest(req({ moduleId: NEW }));
    await unregisterTest(req({ moduleId: NEW }));
    const html = readTestsuite();
    expect(html).not.toContain(NEW);
    expect(occurrences(html, EXISTING)).toBe(1);
  });
});

describe('registerTest / unregisterTest — karma-files-glob', () => {
  const EXISTING = 'webapp/test/unit/Main.controller.qunit.js';
  const NEW = 'webapp/test/unit/controller/App.controller.qunit.js';

  test('register inserts the test file path into the karma files: array', async () => {
    writeKarma([EXISTING]);
    await registerTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    const karma = readKarma();
    expect(karma).toContain(NEW);
    expect(karma).toContain(EXISTING);
  });

  test('register is idempotent for karma-files-glob', async () => {
    writeKarma([EXISTING]);
    await registerTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    await registerTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    expect(occurrences(readKarma(), NEW)).toBe(1);
  });

  test('unregister removes the test file path from the karma files: array', async () => {
    writeKarma([EXISTING, NEW]);
    await unregisterTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    const karma = readKarma();
    expect(karma).not.toContain(NEW);
    expect(karma).toContain(EXISTING);
  });
});

describe('COR-4 — object-form karma files: entries survive a rewrite', () => {
  const HELPER_OBJECT = "{ pattern: 'webapp/test/unit/helper.js', included: false }";
  const EXISTING = 'webapp/test/unit/Main.controller.qunit.js';
  const NEW = 'webapp/test/unit/controller/App.controller.qunit.js';

  function writeKarmaWithObject(): void {
    const conf = [
      'module.exports = function (config) {',
      '  config.set({',
      "    frameworks: ['ui5'],",
      '    files: [',
      `      ${HELPER_OBJECT},`,
      `      '${EXISTING}',`,
      '    ],',
      '  });',
      '};',
      '',
    ].join('\n');
    writeFileSync(join(root, 'karma.conf.js'), conf, 'utf8');
  }

  test('a non-glob object entry still classifies as karma-files-glob', () => {
    writeKarmaWithObject();
    expect(detectDiscoveryMode(root)).toBe('karma-files-glob');
  });

  test('register preserves the object entry (included:false NOT re-defaulted to true)', async () => {
    writeKarmaWithObject();
    await registerTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    const karma = readKarma();
    expect(karma).toContain(NEW); // the new test got registered
    expect(karma).toContain(EXISTING); // the bare entry is kept
    // The object entry must round-trip byte-faithfully. Flattening it to a bare
    // string drops `included: false`, silently re-defaulting the helper to
    // karma's `included: true` and loading a non-test file into the browser —
    // this is the assertion that fails when COR-4 is reverted.
    expect(karma).toContain('included: false');
    expect(karma).toMatch(/pattern:\s*'webapp\/test\/unit\/helper\.js'/);
  });

  test('an add + remove round-trip leaves the object entry byte-intact', async () => {
    writeKarmaWithObject();
    await registerTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    await unregisterTest(req({ mode: 'karma-files-glob', testFileRel: NEW }));
    const karma = readKarma();
    expect(karma).not.toContain(NEW);
    expect(karma).toContain(EXISTING);
    // Exact object source preserved, exactly once.
    expect(karma).toContain(HELPER_OBJECT);
    expect(occurrences(karma, 'included: false')).toBe(1);
  });
});

describe('registerTest — F1: comment/bracket array fidelity', () => {
  function writeRawTestsuite(html: string): void {
    mkdirSync(join(root, 'webapp', 'test'), { recursive: true });
    writeFileSync(join(root, TESTSUITE_REL), html, 'utf8');
  }

  test('a comment containing ] does not orphan the entries after it on rewrite', async () => {
    // The old non-greedy `[\s\S]*?]` stopped at the `]` in `[team-x]`, so "B"
    // fell after the rewritten array's close — corrupting the file and dropping
    // a real entry. The balance-scan reaches the true close.
    const html = [
      '<html><head><script>',
      '    sap.ui.require([',
      '      "app/test/A.qunit", // owner [team-x]',
      '      "app/test/B.qunit"',
      '    ], function () { QUnit.start(); });',
      '</script></head></html>',
      '',
    ].join('\n');
    writeRawTestsuite(html);

    await registerTest(req({ moduleId: 'app/test/C.qunit' }));
    const result = readTestsuite();

    // All three modules are present...
    expect(result).toContain('app/test/A.qunit');
    expect(result).toContain('app/test/B.qunit');
    expect(result).toContain('app/test/C.qunit');

    // ...and every entry is INSIDE the rewritten array — nothing orphaned past
    // its closing bracket.
    const openIx = result.indexOf('[', result.indexOf('sap.ui.require'));
    const closeIx = findMatchingDelimiter(result, openIx, '[', ']');
    expect(closeIx).not.toBeNull();
    const afterClose = closeIx === null ? '' : result.slice(closeIx + 1);
    expect(afterClose).not.toContain('.qunit');

    // The rewritten suite is still a valid registration target.
    expect(detectDiscoveryMode(root)).toBe('testsuite-require');
  });
});

describe('registerTest / unregisterTest — no-op modes', () => {
  test('glob-auto register is a no-op; unregister injects the _failing exclude (E1)', async () => {
    writeKarma(['webapp/test/unit/**/*.qunit.js']);
    const before = readKarma();
    await registerTest(req({ mode: 'glob-auto' }));
    expect(readKarma()).toBe(before); // register stays a no-op for auto-discovery
    await unregisterTest(req({ mode: 'glob-auto' }));
    const after = readKarma();
    expect(after).not.toBe(before);
    expect(after).toContain('exclude');
    expect(after).toContain('**/test/_failing/**');
  });

  test('unknown mode is a no-op and never throws', async () => {
    writeTestsuite(['demo/test/unit/Main.controller.qunit']);
    const before = readTestsuite();
    await registerTest(req({ mode: 'unknown' }));
    await unregisterTest(req({ mode: 'unknown' }));
    expect(readTestsuite()).toBe(before);
  });
});

describe('E1 — glob-auto quarantine karma exclude', () => {
  test('idempotent — unregistering twice leaves a single _failing exclude entry', async () => {
    writeKarma(['webapp/test/**/*.qunit.js']);
    await unregisterTest(req({ mode: 'glob-auto' }));
    await unregisterTest(req({ mode: 'glob-auto' }));
    expect(occurrences(readKarma(), '**/test/_failing/**')).toBe(1);
    // The project is still auto-discovery — only the suite scope narrowed.
    expect(detectDiscoveryMode(root)).toBe('glob-auto');
  });

  test('appends to an existing exclude array, preserving its entries', async () => {
    const conf = [
      'module.exports = function (config) {',
      '  config.set({',
      "    exclude: ['**/legacy/**'],",
      '    files: [',
      "      'webapp/test/**/*.qunit.js'",
      '    ],',
      '  });',
      '};',
      '',
    ].join('\n');
    writeFileSync(join(root, 'karma.conf.js'), conf, 'utf8');
    await unregisterTest(req({ mode: 'glob-auto' }));
    const after = readKarma();
    expect(after).toContain('**/legacy/**'); // existing exclude preserved
    expect(after).toContain('**/test/_failing/**'); // quarantine dir added
    expect(detectDiscoveryMode(root)).toBe('glob-auto');
  });
});
