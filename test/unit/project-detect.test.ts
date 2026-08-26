import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { detectSapUi5Project } from '../../src/project/detect.js';

const FIX_ROOT = join(process.cwd(), 'test', 'fixtures');

describe('detectSapUi5Project — fixtures', () => {
  test('minimal-project detected via ui5.yaml', () => {
    const result = detectSapUi5Project(join(FIX_ROOT, 'minimal-project'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe('ui5.yaml');
  });

  test('no-tests-project detected via ui5.yaml', () => {
    const result = detectSapUi5Project(join(FIX_ROOT, 'no-tests-project'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe('ui5.yaml');
  });

  test('dirty-baseline detected via ui5.yaml', () => {
    const result = detectSapUi5Project(join(FIX_ROOT, 'dirty-baseline'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe('ui5.yaml');
  });

  test('ts-project detected via manifest+component (Component.ts)', () => {
    const result = detectSapUi5Project(join(FIX_ROOT, 'ts-project'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe('manifest+component');
  });
});

describe('detectSapUi5Project — synthetic refusal cases', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sapui5-detect-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('empty directory: not a SAPUI5 project', () => {
    const result = detectSapUi5Project(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Not a SAPUI5 project');
  });

  test('manifest with wrong sap.app.type', () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'webapp', 'manifest.json'),
      JSON.stringify({ 'sap.app': { type: 'library' } }),
    );
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// noop');
    const result = detectSapUi5Project(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('sap.app.type');
      expect(result.message).toContain('"library"');
    }
  });

  test('manifest valid but Component.js/.ts missing', () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'webapp', 'manifest.json'),
      JSON.stringify({ 'sap.app': { type: 'application' } }),
    );
    const result = detectSapUi5Project(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Component.js');
  });

  test('malformed manifest.json reports a parse error', () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'manifest.json'), '{ this is: not json');
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// noop');
    const result = detectSapUi5Project(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Failed to parse');
  });

  test('manifest with sap.app missing entirely', () => {
    mkdirSync(join(tmpRoot, 'webapp'), { recursive: true });
    writeFileSync(join(tmpRoot, 'webapp', 'manifest.json'), JSON.stringify({}));
    writeFileSync(join(tmpRoot, 'webapp', 'Component.js'), '// noop');
    const result = detectSapUi5Project(tmpRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('sap.app.type');
  });
});

describe('detectSapUi5Project — ui5.yaml shortcut', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sapui5-detect-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('ui5.yaml present alone is sufficient (manifest not required)', () => {
    writeFileSync(join(tmpRoot, 'ui5.yaml'), 'specVersion: "3.0"\n');
    const result = detectSapUi5Project(tmpRoot);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe('ui5.yaml');
  });
});
