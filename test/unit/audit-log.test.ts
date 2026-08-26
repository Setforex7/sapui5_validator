import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/log.js';

describe('AuditLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sapui5-audit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('default mode writes under .sapui5-validator/last-run', async () => {
    const log = new AuditLog({ projectRoot: dir, keepHistory: false });
    expect(log.rootDir).toBe(join(dir, '.sapui5-validator', 'last-run'));
    await log.writePrompt('call-001', 'hello');
    const content = await readFile(
      join(dir, '.sapui5-validator', 'last-run', 'prompts', 'call-001.txt'),
      'utf8',
    );
    expect(content).toBe('hello');
  });

  it('keepHistory mode writes under .sapui5-validator/runs/<timestamp>', async () => {
    const startedAt = new Date('2026-05-12T10:20:30Z');
    const log = new AuditLog({ projectRoot: dir, keepHistory: true, startedAt });
    expect(log.rootDir).toBe(
      join(dir, '.sapui5-validator', 'runs', '2026-05-12T10-20-30Z'),
    );
    await log.writeResponse('call-002', '{"ok":true}');
    const target = join(log.rootDir, 'responses', 'call-002.json');
    expect((await stat(target)).isFile()).toBe(true);
  });

  it('writeVerify scopes by step name', async () => {
    const log = new AuditLog({ projectRoot: dir, keepHistory: false });
    await log.writeVerify('call-003', 'ui5lint', 'lint output');
    const content = await readFile(
      join(log.rootDir, 'verify', 'call-003-ui5lint.txt'),
      'utf8',
    );
    expect(content).toBe('lint output');
  });
});
