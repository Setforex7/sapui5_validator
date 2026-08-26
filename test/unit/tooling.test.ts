import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ExecResult } from '../../src/util/exec.js';
import {
  type ProbeAdapter,
  type ProbeOutcome,
  type ToolName,
  defaultProbeAdapter,
  probeTooling,
  withNpxFallback,
} from '../../src/project/tooling.js';

function fakeAdapter(map: Partial<Record<ToolName, ProbeOutcome>>): ProbeAdapter {
  const byModule: Record<string, ProbeOutcome> = {};
  if (map.ui5lint) byModule['@ui5/linter'] = map.ui5lint;
  if (map.karma) byModule['karma'] = map.karma;
  if (map.eslint) byModule['eslint'] = map.eslint;
  return {
    probe(_root, spec) {
      return byModule[spec.modulePath] ?? { present: false };
    },
  };
}

describe('probeTooling — classification matrix', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-tooling-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('all three present and listed → no hard fail, no skipped optional', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { eslint: '^9.0.0' } }),
    );
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: true, version: '1.2.3', source: 'node_modules' },
        karma: { present: true, version: '6.4.0', source: 'node_modules' },
        eslint: { present: true, version: '9.0.0', source: 'node_modules' },
      }),
    });
    expect(result.hardFail).toBe(false);
    expect(result.missingRequired).toEqual([]);
    expect(result.skippedOptional).toEqual([]);
    expect(result.tools.find((t) => t.name === 'ui5lint')?.classification).toBe('required');
    expect(result.tools.find((t) => t.name === 'karma')?.classification).toBe('required');
    expect(result.tools.find((t) => t.name === 'eslint')?.classification).toBe('conditional');
  });

  test('eslint not in package.json → classification "optional"', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({}));
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: true },
        karma: { present: true },
        eslint: { present: false },
      }),
    });
    const eslint = result.tools.find((t) => t.name === 'eslint');
    expect(eslint?.classification).toBe('optional');
    expect(eslint?.status).toBe('missing');
    expect(result.hardFail).toBe(false);
    expect(result.skippedOptional).toEqual(['eslint']);
    expect(result.missingRequired).toEqual([]);
  });

  test('eslint listed but missing → conditional + hard fail', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { eslint: '^9.0.0' } }),
    );
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: true },
        karma: { present: true },
        eslint: { present: false },
      }),
    });
    expect(result.hardFail).toBe(true);
    expect(result.missingRequired).toEqual(['eslint']);
    const eslint = result.tools.find((t) => t.name === 'eslint');
    expect(eslint?.classification).toBe('conditional');
    expect(eslint?.detail).toContain('not installed');
  });

  test('ui5lint missing → hard fail (required)', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: false },
        karma: { present: true },
        eslint: { present: false },
      }),
    });
    expect(result.hardFail).toBe(true);
    expect(result.missingRequired).toEqual(['ui5lint']);
  });

  test('karma missing → hard fail (required, V1 only supports karma)', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: true },
        karma: { present: false },
        eslint: { present: false },
      }),
    });
    expect(result.hardFail).toBe(true);
    expect(result.missingRequired).toEqual(['karma']);
    expect(result.tools.find((t) => t.name === 'karma')?.detail).toContain('§2.10');
  });

  test('V1.9 — TS project: karma is NOT required (the static lane never runs it)', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const result = await probeTooling(root, {
      projectLanguage: 'ts',
      adapter: fakeAdapter({
        ui5lint: { present: true },
        // karma absent — legitimate for a TS project that ships no karma.
        eslint: { present: false },
      }),
    });
    expect(result.hardFail).toBe(false);
    expect(result.missingRequired).toEqual([]);
    expect(result.tools.find((t) => t.name === 'karma')?.classification).toBe('optional');
  });

  test('V1.9 — TS honest-refusal floor: ui5lint stays required (its absence hard-fails TS)', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const result = await probeTooling(root, {
      projectLanguage: 'ts',
      adapter: fakeAdapter({
        ui5lint: { present: false },
        karma: { present: false },
        eslint: { present: false },
      }),
    });
    expect(result.hardFail).toBe(true);
    expect(result.missingRequired).toEqual(['ui5lint']);
  });

  test('missing reports always have source "unknown"', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: false },
        karma: { present: false },
        eslint: { present: false },
      }),
    });
    for (const tool of result.tools) {
      if (tool.status === 'missing') expect(tool.source).toBe('unknown');
    }
  });

  test('present reports preserve version and source from the probe', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const result = await probeTooling(root, {
      adapter: fakeAdapter({
        ui5lint: { present: true, version: '1.5.0', source: 'global' },
        karma: { present: true, source: 'node_modules' },
        eslint: { present: false },
      }),
    });
    const ui5lint = result.tools.find((t) => t.name === 'ui5lint');
    expect(ui5lint?.version).toBe('1.5.0');
    expect(ui5lint?.source).toBe('global');
    const karma = result.tools.find((t) => t.name === 'karma');
    expect(karma?.version).toBeUndefined();
    expect(karma?.source).toBe('node_modules');
  });
});

describe('defaultProbeAdapter (filesystem)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-tooling-fs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('reports missing when node_modules entry is absent', () => {
    const out = defaultProbeAdapter.probe(root, { modulePath: 'eslint' });
    expect(out.present).toBe(false);
  });

  test('reports present + version when node_modules entry is present', () => {
    mkdirSync(join(root, 'node_modules', 'eslint'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'eslint', 'package.json'),
      JSON.stringify({ name: 'eslint', version: '9.7.0' }),
    );
    const out = defaultProbeAdapter.probe(root, { modulePath: 'eslint' });
    expect(out.present).toBe(true);
    expect(out.version).toBe('9.7.0');
    expect(out.source).toBe('node_modules');
  });

  test('reports present without version when package.json lacks one', () => {
    mkdirSync(join(root, 'node_modules', '@ui5', 'linter'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', '@ui5', 'linter', 'package.json'),
      JSON.stringify({ name: '@ui5/linter' }),
    );
    const out = defaultProbeAdapter.probe(root, { modulePath: '@ui5/linter' });
    expect(out.present).toBe(true);
    expect(out.version).toBeUndefined();
  });

  test('reports present (no version) when package.json is malformed', () => {
    mkdirSync(join(root, 'node_modules', 'karma'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'karma', 'package.json'), 'not json');
    const out = defaultProbeAdapter.probe(root, { modulePath: 'karma' });
    expect(out.present).toBe(true);
    expect(out.version).toBeUndefined();
  });
});

describe('withNpxFallback', () => {
  function fakeExec(stdout: string, ok: boolean): (
    bin: string,
    args: readonly string[],
    opts: { cwd: string },
  ) => Promise<ExecResult> {
    return async () => ({ ok, stdout, stderr: '', exitCode: ok ? 0 : 1, durationMs: 1 });
  }

  test('returns the inner outcome when the filesystem probe already found the tool', async () => {
    const inner: ProbeAdapter = { probe: () => ({ present: true, version: '1.0.0', source: 'node_modules' }) };
    let execCalls = 0;
    const wrapped = withNpxFallback(inner, async () => {
      execCalls += 1;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
    });
    const out = await wrapped.probe('/proj', { modulePath: '@ui5/linter', binName: 'ui5lint' });
    expect(out.present).toBe(true);
    expect(out.source).toBe('node_modules');
    expect(execCalls).toBe(0); // no npx probe needed when inner is positive
  });

  test('falls back to `npx --no-install <bin> --version` when inner reports missing', async () => {
    const inner: ProbeAdapter = { probe: () => ({ present: false }) };
    const wrapped = withNpxFallback(inner, fakeExec('1.2.3\n', true));
    const out = await wrapped.probe('/proj', { modulePath: '@ui5/linter', binName: 'ui5lint' });
    expect(out.present).toBe(true);
    expect(out.source).toBe('global');
    expect(out.version).toBe('1.2.3');
  });

  test('returns the original missing outcome when npx also fails', async () => {
    const inner: ProbeAdapter = { probe: () => ({ present: false }) };
    const wrapped = withNpxFallback(inner, fakeExec('', false));
    const out = await wrapped.probe('/proj', { modulePath: '@ui5/linter', binName: 'ui5lint' });
    expect(out.present).toBe(false);
  });

  test('returns the original missing outcome when no binName is provided', async () => {
    const inner: ProbeAdapter = { probe: () => ({ present: false }) };
    let execCalls = 0;
    const wrapped = withNpxFallback(inner, async () => {
      execCalls += 1;
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
    });
    const out = await wrapped.probe('/proj', { modulePath: '@ui5/linter' });
    expect(out.present).toBe(false);
    expect(execCalls).toBe(0);
  });

  test('marks present but version undefined when npx stdout has no parseable version', async () => {
    const inner: ProbeAdapter = { probe: () => ({ present: false }) };
    const wrapped = withNpxFallback(inner, fakeExec('weird output', true));
    const out = await wrapped.probe('/proj', { modulePath: 'karma', binName: 'karma' });
    expect(out.present).toBe(true);
    expect(out.version).toBeUndefined();
    expect(out.source).toBe('global');
  });

  test('COR-9: a hanging npx is bounded by the probe timeout and falls back to not-found', async () => {
    const inner: ProbeAdapter = { probe: () => ({ present: false }) };
    let attempted = false;
    // An exec impl that never resolves (ignores the timeout it is passed),
    // standing in for a hung npx / slow PATH. Without the wrapper-level timeout
    // race this `probe` would hang forever and the test would time out.
    const hangingExec = (): Promise<ExecResult> => {
      attempted = true;
      return new Promise<ExecResult>(() => {
        /* never settles */
      });
    };
    const wrapped = withNpxFallback(inner, hangingExec, 30);
    const out = await wrapped.probe('/proj', { modulePath: 'eslint', binName: 'eslint' });
    expect(attempted).toBe(true); // the fallback DID attempt npx...
    expect(out.present).toBe(false); // ...and the timeout fell back to the inner outcome
  });
});
