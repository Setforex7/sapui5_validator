import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadTsconfigScope } from '../../src/util/tsconfig-scope.js';

/**
 * V1.9.2 (TG-ACCEPT / FS-6) — the tsconfig-scope guard. `loadTsconfigScope`
 * answers "would project-wide `tsc --noEmit` type-check this path?". The accept
 * predicate fails CLOSED when the generated `.qunit.ts` would land outside the
 * tsconfig `include` scope (else a tsc-green is vacuous). Every ambiguous case
 * resolves to NOT covered. Reverting a matcher branch flips a verdict → RED.
 */
describe('loadTsconfigScope', () => {
  let root: string;
  const testFile = (): string =>
    join(root, 'webapp', 'test', 'unit', 'controller', 'App.controller.qunit.ts');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-tsscope-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeTsconfig = (obj: unknown): void => {
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(obj), 'utf8');
  };

  test('the standard UI5-TS include ["./webapp/**/*"] covers webapp/test/unit', () => {
    writeTsconfig({ include: ['./webapp/**/*'] });
    const scope = loadTsconfigScope(root);
    expect(scope.found).toBe(true);
    expect(scope.covers(testFile())).toBe(true);
  });

  test('a bare directory include ["webapp"] covers the whole subtree', () => {
    writeTsconfig({ include: ['webapp'] });
    expect(loadTsconfigScope(root).covers(testFile())).toBe(true);
  });

  test('a narrow include that omits the test dir does NOT cover it (fail-closed)', () => {
    writeTsconfig({ include: ['webapp/controller/**/*'] });
    const scope = loadTsconfigScope(root);
    expect(scope.covers(testFile())).toBe(false);
    expect(
      scope.covers(join(root, 'webapp', 'controller', 'App.controller.ts')),
    ).toBe(true);
  });

  test('an explicit exclude of webapp/test removes it from scope', () => {
    writeTsconfig({ include: ['webapp/**/*'], exclude: ['webapp/test'] });
    const scope = loadTsconfigScope(root);
    expect(scope.covers(testFile())).toBe(false);
    expect(scope.covers(join(root, 'webapp', 'controller', 'App.ts'))).toBe(true);
  });

  test('a path outside the tsconfig directory is never covered', () => {
    writeTsconfig({ include: ['webapp/**/*'] });
    const scope = loadTsconfigScope(root);
    expect(scope.covers(join(root, '..', 'elsewhere', 'X.ts'))).toBe(false);
  });

  test('no tsconfig.json → not found, covers() is false (fail-closed)', () => {
    const scope = loadTsconfigScope(root);
    expect(scope.found).toBe(false);
    expect(scope.covers(testFile())).toBe(false);
  });

  test('a malformed tsconfig.json → covers() is false (fail-closed)', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{ this is : not json ]', 'utf8');
    const scope = loadTsconfigScope(root);
    expect(scope.found).toBe(false);
    expect(scope.covers(testFile())).toBe(false);
  });

  test('JSONC comments and trailing commas are tolerated', () => {
    writeFileSync(
      join(root, 'tsconfig.json'),
      [
        '{',
        '  // the UI5-TS standard',
        '  "compilerOptions": { "strict": true }, /* block */',
        '  "include": ["./webapp/**/*"],',
        '}',
      ].join('\n'),
      'utf8',
    );
    expect(loadTsconfigScope(root).covers(testFile())).toBe(true);
  });

  test('files without include → only the listed files are in scope', () => {
    writeTsconfig({ files: ['webapp/index.ts'] });
    const scope = loadTsconfigScope(root);
    expect(scope.covers(join(root, 'webapp', 'index.ts'))).toBe(true);
    expect(scope.covers(testFile())).toBe(false);
  });

  test('one level of extends is inherited for include', () => {
    writeFileSync(
      join(root, 'tsconfig.base.json'),
      JSON.stringify({ include: ['./webapp/**/*'] }),
      'utf8',
    );
    writeTsconfig({ extends: './tsconfig.base.json' });
    expect(loadTsconfigScope(root).covers(testFile())).toBe(true);
  });

  test('absent include and files → the implicit **/* covers everything under the dir', () => {
    writeTsconfig({ compilerOptions: { strict: true } });
    const scope = loadTsconfigScope(root);
    expect(scope.covers(testFile())).toBe(true);
    // node_modules is excluded by default even with the implicit include.
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    expect(scope.covers(join(root, 'node_modules', 'pkg', 'index.ts'))).toBe(false);
  });
});
