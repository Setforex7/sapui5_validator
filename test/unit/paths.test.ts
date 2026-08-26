import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAILING_TEST_SUFFIX,
  REPORT_FILE,
  VALIDATOR_DIR,
  failingTestsDir,
  isoTimestampForDir,
  lastRunDir,
  reportPath,
  runHistoryDir,
  validatorDir,
} from '../../src/util/paths.js';

describe('paths', () => {
  const root = '/tmp/my-project';

  it('exposes the validator directory name', () => {
    expect(VALIDATOR_DIR).toBe('.sapui5-validator');
    expect(REPORT_FILE).toBe('report.json');
    expect(FAILING_TEST_SUFFIX).toBe('.failing.qunit.js');
  });

  it('validatorDir joins under the project root', () => {
    expect(validatorDir(root)).toBe(join(root, '.sapui5-validator'));
  });

  it('reportPath resolves to .sapui5-validator/report.json under the project root', () => {
    expect(reportPath(root)).toBe(join(root, '.sapui5-validator', 'report.json'));
  });

  it('lastRunDir resolves to .sapui5-validator/last-run', () => {
    expect(lastRunDir(root)).toBe(join(root, '.sapui5-validator', 'last-run'));
  });

  it('runHistoryDir nests an ISO timestamp under runs/', () => {
    const ts = '2026-05-12T10-20-30Z';
    expect(runHistoryDir(root, ts)).toBe(join(root, '.sapui5-validator', 'runs', ts));
  });

  it('failingTestsDir resolves to webapp/test/_failing', () => {
    expect(failingTestsDir(root)).toBe(join(root, 'webapp/test/_failing'));
  });

  it('isoTimestampForDir produces a filesystem-safe ISO without colons', () => {
    const ts = isoTimestampForDir(new Date('2026-05-12T10:20:30.456Z'));
    expect(ts).toBe('2026-05-12T10-20-30Z');
    expect(ts).not.toMatch(/[:.]/);
  });
});
