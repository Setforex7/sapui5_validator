/**
 * SPEC §2.8 check #3: missing teardown in QUnit tests.
 *
 * Flag QUnit modules that create UI controls (or any disposable framework
 * object) inside `beforeEach` without a matching `afterEach` that calls
 * `destroy()`. Applies to `.qunit.js` files under the project's test root.
 * Single-file fix.
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { ProjectLanguage } from '../project/detect.js';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings, sourceFence, tsSourceGuidance } from './_shared.js';

export function buildMissingTeardownPrompt(args: {
  readonly relPath: string;
  readonly content: string;
  readonly language?: ProjectLanguage;
}): string {
  const language = args.language ?? 'js';
  return [
    'Static check: `missing-teardown`.',
    '',
    'Inspect this QUnit test file. For each `QUnit.module(...)` declaration,',
    'check whether the `beforeEach` hook constructs UI controls or any object',
    'that owns a `destroy()` lifecycle. A module is in violation when:',
    '  - the `beforeEach` creates such an object AND',
    '  - the corresponding `afterEach` either is absent or does not call',
    '    `destroy()` on the created object(s).',
    'Do NOT flag modules whose only setup is plain data (strings, plain',
    'objects, mocks that do not own framework resources).',
    '',
    ...tsSourceGuidance(language),
    `File: ${args.relPath}`,
    '```' + sourceFence(language),
    args.content,
    '```',
    '',
    'Output: {"findings": [Finding, ...]}',
    'Each Finding has:',
    '  - "checkId": "missing-teardown"',
    `  - "file": "${args.relPath}"`,
    '  - "line": <1-based line number of the offending `QUnit.module` or',
    '    `beforeEach`>',
    '  - "message": short description',
    '  - EITHER',
    '      "proposedFix": {"newFileContent": "<full rewritten file content>"}',
    '    (when the missing teardown can be added safely within this file alone)',
    '    OR',
    '      "proposedFix": null,',
    '      "explanation": "<why this needs human action>"',
    '    (when a safe single-file rewrite is not possible).',
    '',
    'Coalesce all violations into a single finding whose proposedFix fixes',
    'every module in the file. Return {"findings": []} if clean.',
  ].join('\n');
}

export const missingTeardownCheck: CheckModule = {
  id: 'missing-teardown',
  scope: 'qunit-test',
  async run(target, ctx): Promise<CheckResult> {
    const content = await readFile(target, 'utf8');
    const relPath = toPosix(relative(ctx.projectRoot, target));
    const prompt = buildMissingTeardownPrompt({
      relPath,
      content,
      language: ctx.projectLanguage ?? 'js',
    });
    const findings = await callLlmForFindings({
      checkId: 'missing-teardown',
      file: relPath,
      prompt,
      mode: 'auto-fixable-or-manual',
      ctx,
    });
    return { findings };
  },
};

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
