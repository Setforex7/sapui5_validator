/**
 * SPEC §2.8 check #2: no synchronous OData calls.
 *
 * Flag `async: false`, synchronous `loadData` calls on `JSONModel`, and
 * synchronous CRUD calls (`read`, `create`, `update`, `remove`) on OData
 * models where the model API expects the async pattern. Single-file fix.
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { ProjectLanguage } from '../project/detect.js';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings, sourceFence, tsSourceGuidance } from './_shared.js';

export function buildNoSyncOdataPrompt(args: {
  readonly relPath: string;
  readonly content: string;
  readonly language?: ProjectLanguage;
}): string {
  const language = args.language ?? 'js';
  return [
    'Static check: `no-sync-odata`.',
    '',
    'Inspect this SAPUI5 JavaScript file for synchronous OData / model usage.',
    'Flag:',
    '  - any options object passed to `new ODataModel(...)`, `new JSONModel(...)`,',
    '    `loadData`, `read`, `create`, `update`, or `remove` that contains',
    '    `async: false`;',
    '  - any call to `loadData(...)` whose last positional argument is the',
    '    literal `false` (legacy sync form);',
    '  - any property assignment that sets `bSynchronous = true` or',
    '    `useBatch = false` on an OData v2 model where the surrounding code',
    '    awaits no promise.',
    'Do not flag idiomatic async usage (Promise-returning calls, `requestObject`,',
    '`requestProperty`, etc.).',
    '',
    ...tsSourceGuidance(language),
    `File: ${args.relPath}`,
    '```' + sourceFence(language),
    args.content,
    '```',
    '',
    'Output: a single JSON object {"findings": [Finding, ...]}',
    'Each Finding has:',
    '  - "checkId": "no-sync-odata"',
    `  - "file": "${args.relPath}"`,
    '  - "line": <1-based line number>',
    '  - "message": short description',
    '  - EITHER',
    '      "proposedFix": {"newFileContent": "<full rewritten file content>"}',
    '    (when the violations can be rewritten safely within this file alone)',
    '    OR',
    '      "proposedFix": null,',
    '      "explanation": "<why this needs human action>"',
    '    (when a safe single-file rewrite is not possible).',
    '',
    'Coalesce multiple violations in the same file into one finding whose',
    'proposedFix rewrites them all. Return {"findings": []} if clean.',
  ].join('\n');
}

export const noSyncOdataCheck: CheckModule = {
  id: 'no-sync-odata',
  scope: 'controller-js',
  async run(target, ctx): Promise<CheckResult> {
    const content = await readFile(target, 'utf8');
    const relPath = toPosix(relative(ctx.projectRoot, target));
    const prompt = buildNoSyncOdataPrompt({
      relPath,
      content,
      language: ctx.projectLanguage ?? 'js',
    });
    const findings = await callLlmForFindings({
      checkId: 'no-sync-odata',
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
