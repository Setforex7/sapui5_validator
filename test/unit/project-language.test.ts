/**
 * V1.9 Phase 0 — TS-DETECT. `detectProjectLanguage` must classify a real
 * TS-SAPUI5 project as `'ts'` and leave every JS project (including one that
 * merely ships a hand-written `.d.ts`) as `'js'`. Detection is read-only and
 * must never throw — a `'js'` default is the safe floor, and a false `'ts'`
 * only ever routes to the Phase-0 honest refusal.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { detectProjectLanguage, listWebappTsSources } from '../../src/project/detect.js';

const FIX_ROOT = join(process.cwd(), 'test', 'fixtures');

describe('detectProjectLanguage — fixtures', () => {
  test('ts-helloworld (TS) → ts', async () => {
    expect(await detectProjectLanguage(join(FIX_ROOT, 'ts-helloworld'))).toBe('ts');
  });

  test('ts-project (TS) → ts', async () => {
    expect(await detectProjectLanguage(join(FIX_ROOT, 'ts-project'))).toBe('ts');
  });

  test('minimal-project (JS) → js', async () => {
    expect(await detectProjectLanguage(join(FIX_ROOT, 'minimal-project'))).toBe('js');
  });

  test('no-tests-project (JS) → js', async () => {
    expect(await detectProjectLanguage(join(FIX_ROOT, 'no-tests-project'))).toBe('js');
  });
});

describe('listWebappTsSources — fixtures', () => {
  test('ts-helloworld lists the source .ts but excludes Component.ts? (it is a source) and env.d.ts', async () => {
    const sources = await listWebappTsSources(join(FIX_ROOT, 'ts-helloworld'));
    // The ambient declaration is never a source.
    expect(sources).not.toContain('webapp/env.d.ts');
    // Controller + Component are real `.ts` sources (discovery, not detection,
    // decides which are *analysis targets* — Component is excluded there).
    expect(sources).toContain('webapp/controller/App.controller.ts');
    expect(sources).toContain('webapp/Component.ts');
  });
});

describe('detectProjectLanguage — synthetic edge cases', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sapui5-lang-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('empty / nonexistent dir → js (read-only, never throws)', async () => {
    expect(await detectProjectLanguage(tmpRoot)).toBe('js');
    expect(await detectProjectLanguage(join(tmpRoot, 'does-not-exist'))).toBe('js');
  });

  test('a JS project shipping only a .d.ts declaration stays js (fixes the old guard wart)', async () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// js');
    writeFileSync(join(tmpRoot, 'webapp', 'types.d.ts'), 'export {};');
    expect(await detectProjectLanguage(tmpRoot)).toBe('js');
    expect(await listWebappTsSources(tmpRoot)).toEqual([]);
  });

  test('a single non-declaration .ts under webapp → ts', async () => {
    mkdirSync(join(tmpRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'controller', 'X.controller.ts'), '// ts');
    expect(await detectProjectLanguage(tmpRoot)).toBe('ts');
    expect(await listWebappTsSources(tmpRoot)).toEqual(['webapp/controller/X.controller.ts']);
  });

  test('tsconfig.json ALONE (no .ts source, no transpile task) does NOT flip a JS project to ts', async () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// js');
    writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
    expect(await detectProjectLanguage(tmpRoot)).toBe('js');
  });

  test('secondary signal: tsconfig.json + ui5-tooling-transpile in ui5.yaml → ts (no webapp .ts needed)', async () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// js');
    writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
    writeFileSync(
      join(tmpRoot, 'ui5.yaml'),
      'specVersion: "4.0"\nbuilder:\n  customTasks:\n    - name: ui5-tooling-transpile-task\n',
    );
    expect(await detectProjectLanguage(tmpRoot)).toBe('ts');
  });

  test('.ts inside webapp/node_modules is ignored', async () => {
    mkdirSync(join(tmpRoot, 'webapp', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'node_modules', 'pkg', 'index.ts'), '// ts');
    expect(await detectProjectLanguage(tmpRoot)).toBe('js');
    expect(await listWebappTsSources(tmpRoot)).toEqual([]);
  });
});
