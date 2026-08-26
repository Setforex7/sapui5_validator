import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { TS_REFUSAL_MESSAGE, checkTsGuard } from '../../src/project/ts-guard.js';

const FIX_ROOT = join(process.cwd(), 'test', 'fixtures');

describe('checkTsGuard — fixture coverage (a JS project proceeds for both commands)', () => {
  for (const command of ['validate', 'generate'] as const) {
    test(`minimal-project passes (${command}) — language 'js'`, async () => {
      const result = await checkTsGuard(join(FIX_ROOT, 'minimal-project'), { command });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.language).toBe('js');
    });

    test(`no-tests-project passes (${command})`, async () => {
      const result = await checkTsGuard(join(FIX_ROOT, 'no-tests-project'), { command });
      expect(result.ok).toBe(true);
    });

    test(`dirty-baseline passes (${command})`, async () => {
      const result = await checkTsGuard(join(FIX_ROOT, 'dirty-baseline'), { command });
      expect(result.ok).toBe(true);
    });
  }
});

describe('checkTsGuard — V1.9/V1.9.2: validate AND generate proceed for TS', () => {
  test("ts-project: validate PROCEEDS (ok, language 'ts')", async () => {
    const result = await checkTsGuard(join(FIX_ROOT, 'ts-project'), { command: 'validate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.language).toBe('ts');
  });

  test("ts-project: generate now PROCEEDS for TS (V1.9.2 — ok, language 'ts')", async () => {
    const result = await checkTsGuard(join(FIX_ROOT, 'ts-project'), { command: 'generate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.language).toBe('ts');
  });

  test("ts-helloworld: validate AND generate both proceed 'ts'", async () => {
    const v = await checkTsGuard(join(FIX_ROOT, 'ts-helloworld'), { command: 'validate' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.language).toBe('ts');

    const g = await checkTsGuard(join(FIX_ROOT, 'ts-helloworld'), { command: 'generate' });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.language).toBe('ts');
  });

  // Fail-on-revert teeth: if the V1.9.2 generate-lift were reverted (generate
  // refused TS again) `g.ok` goes false → RED; likewise the V1.9 validate flip
  // would make `v.ok` false → RED.
  test('no command refuses TS: validate and generate both proceed on the SAME project', async () => {
    const root = join(FIX_ROOT, 'ts-helloworld');
    const v = await checkTsGuard(root, { command: 'validate' });
    const g = await checkTsGuard(root, { command: 'generate' });
    expect(v.ok).toBe(true);
    expect(g.ok).toBe(true);
  });
});

describe('TS_REFUSAL_MESSAGE — exact SPEC §2.5 text', () => {
  test('verbatim string', () => {
    expect(TS_REFUSAL_MESSAGE).toBe('TypeScript SAPUI5 support is planned for V2.');
  });
});

describe('checkTsGuard — synthetic cases', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sapui5-tsguard-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('no webapp directory at all → ok (js)', async () => {
    const result = await checkTsGuard(tmpRoot, { command: 'validate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.language).toBe('js');
  });

  test('a single .ts file under webapp/ → generate proceeds (ts)', async () => {
    mkdirSync(join(tmpRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'controller', 'X.controller.ts'), '// ts');
    const result = await checkTsGuard(tmpRoot, { command: 'generate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.language).toBe('ts');
  });

  test('a single .ts file under webapp/ → validate proceeds (ts)', async () => {
    mkdirSync(join(tmpRoot, 'webapp', 'controller'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'controller', 'X.controller.ts'), '// ts');
    const result = await checkTsGuard(tmpRoot, { command: 'validate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.language).toBe('ts');
  });

  test('only .js files under webapp/ → ok (js) for both commands', async () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// js');
    expect((await checkTsGuard(tmpRoot, { command: 'validate' })).ok).toBe(true);
    expect((await checkTsGuard(tmpRoot, { command: 'generate' })).ok).toBe(true);
  });

  test('.ts files inside webapp/node_modules are ignored → js', async () => {
    mkdirSync(join(tmpRoot, 'webapp', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'node_modules', 'pkg', 'index.ts'), '// ts');
    const result = await checkTsGuard(tmpRoot, { command: 'validate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.language).toBe('js');
  });
});
