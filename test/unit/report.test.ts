import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_SCHEMA_VERSION,
  createEmptyReport,
  serializeReport,
  writeReport,
} from '../../src/output/report.js';
import type { RunReport } from '../../src/types.js';

describe('report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sapui5-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createEmptyReport seeds the current REPORT_SCHEMA_VERSION and zeroed counters', () => {
    const started = new Date('2026-05-12T10:00:00Z');
    const report = createEmptyReport('validate', started, 50);
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(REPORT_SCHEMA_VERSION).toBe(2);
    expect(report.command).toBe('validate');
    expect(report.startedAt).toBe('2026-05-12T10:00:00.000Z');
    expect(report.llmCallCount).toBe(0);
    expect(report.llmCallBudget).toBe(50);
    expect(report.exitReason.kind).toBe('success');
    expect(report.files).toEqual([]);
    expect(report.generatedTests).toEqual([]);
  });

  it('writeReport writes pretty JSON to .sapui5-validator/report.json', async () => {
    const started = new Date('2026-05-12T10:00:00Z');
    const report: RunReport = {
      ...createEmptyReport('validate', started, 50),
      exitReason: { kind: 'unfixed-findings', remaining: 2 },
      exitCode: 1,
      files: [
        {
          file: 'webapp/controller/Main.controller.js',
          findings: [
            {
              checkId: 'no-direct-dom',
              file: 'webapp/controller/Main.controller.js',
              line: 14,
              message: 'document.querySelector is forbidden',
              source: 'check',
              proposedFix: { newFileContent: '// patched' },
            },
          ],
          appliedFixes: [],
          revertedFixes: [
            { checkId: 'no-direct-dom', source: 'check', reason: 'verify failed 3x' },
          ],
        },
      ],
    };

    const target = await writeReport(dir, report);
    expect(target).toBe(join(dir, '.sapui5-validator', 'report.json'));

    const content = await readFile(target, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed: unknown = JSON.parse(content);
    expect(parsed).toEqual(report);
  });

  it('serializeReport emits valid JSON with stable shape', () => {
    const report = createEmptyReport('generate', new Date('2026-05-12T10:00:00Z'), 25);
    const json: unknown = JSON.parse(serializeReport(report));
    expect(json).toMatchObject({
      schemaVersion: 2,
      command: 'generate',
      llmCallBudget: 25,
      llmCallCount: 0,
    });
  });

  it('createEmptyReport omits the additive PERF-1 usage/cost fields', () => {
    const report = createEmptyReport('validate', new Date('2026-05-12T10:00:00Z'), 50);
    // Absent until at least one call reports usage — additive optional.
    expect(report.usage).toBeUndefined();
    expect(report.totalCostUsd).toBeUndefined();
    expect(report.schemaVersion).toBe(2);
  });

  it('PERF-1: a report carrying summed usage/cost round-trips at schemaVersion 2', async () => {
    const started = new Date('2026-05-12T10:00:00Z');
    const report: RunReport = {
      ...createEmptyReport('validate', started, 50),
      usage: {
        inputTokens: 30,
        outputTokens: 15,
        cacheReadTokens: 300,
        cacheCreationTokens: 600,
      },
      totalCostUsd: 0.03,
    };

    const target = await writeReport(dir, report);
    const parsed = JSON.parse(await readFile(target, 'utf8')) as RunReport;
    // Additive fields survive the round-trip and the version is unchanged, so a
    // v2 reader that ignores unknown keys still parses it.
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.usage).toEqual(report.usage);
    expect(parsed.totalCostUsd).toBe(0.03);
  });
});
