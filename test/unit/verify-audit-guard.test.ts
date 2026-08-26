/**
 * R2.3(iii) (AUDIT §5.4) — the verify-audit transcript write is best-effort.
 *
 * `wrapVerifyFnWithAudit` decorates the PRODUCTION verifyFn for both
 * orchestrators, so pre-R2.3 a failed `writeVerify` (full disk, locked
 * last-run/ dir) threw straight through the verify path — the exact throw
 * class the lane (R2.3 i) and the validate revert guard (R2.3 ii) exist to
 * contain. The witness proves the failure is swallowed with a warning and
 * the verify result still reaches the caller.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditLog } from '../../src/audit/log.js';
import { wrapVerifyFnWithAudit } from '../../src/audit/runner.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

const VERIFY_OK: VerifyResult = {
  ok: true,
  steps: [
    {
      step: 'ui5lint',
      status: 'passed',
      stdout: 'clean',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    },
  ],
  feedbackForLlm: '',
};

describe('wrapVerifyFnWithAudit — audit-write failures are swallowed (R2.3 iii)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sapui5-validator-r23iii-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test('a throwing audit writer → verify result returned, warning written, no throw', async () => {
    const audit = new AuditLog({ projectRoot, keepHistory: false });
    vi.spyOn(audit, 'writeVerify').mockRejectedValue(new Error('ENOSPC: disk full'));
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const wrapped = wrapVerifyFnWithAudit(async () => VERIFY_OK, audit);
    const result = await wrapped({
      projectRoot,
      file: join(projectRoot, 'webapp', 'x.js'),
      eslintEnabled: false,
    });

    // The run continues: the inner result is returned unchanged.
    expect(result).toBe(VERIFY_OK);
    // ...and the swallow is not silent.
    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(warnings).toMatch(/failed to write verify audit transcript/);
    expect(warnings).toMatch(/ENOSPC: disk full/);
  });

  test('control: a healthy audit writer still lands one transcript per non-skipped step', async () => {
    const audit = new AuditLog({ projectRoot, keepHistory: false });
    const writeSpy = vi.spyOn(audit, 'writeVerify');

    const wrapped = wrapVerifyFnWithAudit(async () => VERIFY_OK, audit);
    await wrapped({
      projectRoot,
      file: join(projectRoot, 'webapp', 'x.js'),
      eslintEnabled: false,
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.any(String),
      'ui5lint',
      expect.stringContaining('status: passed'),
    );
  });
});
