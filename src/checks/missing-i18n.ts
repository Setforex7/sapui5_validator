/**
 * SPEC §2.8 check #4: missing i18n in XML views.
 *
 * Flag hardcoded human-readable strings on view properties that should be
 * driven by an `{i18n>key}` binding. Properties typically affected:
 * `text`, `title`, `placeholder`, `tooltip`, `description`. Ignore strings
 * that already look like bindings (`{...}`), property paths, and very short
 * non-localisable tokens (single chars, numbers).
 * Single-file fix.
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings } from './_shared.js';

export function buildMissingI18nPrompt(args: {
  readonly relPath: string;
  readonly content: string;
}): string {
  return [
    'Static check: `missing-i18n`.',
    '',
    'Inspect this SAPUI5 XML view. Flag human-readable string attributes that',
    'should be replaced with an `{i18n>key}` binding. Attributes that count:',
    '  - `text`, `title`, `placeholder`, `tooltip`, `description`,',
    '  - `headerText`, `footerText`, `label`.',
    'Do NOT flag values that already look like a binding (start with `{` and',
    'end with `}`), pure-numeric values, single-character icons, or values',
    'that are clearly identifiers (no spaces, camelCase, or ALL_CAPS).',
    'When proposing a fix, introduce a stable kebab-or-camelCase i18n key',
    'derived from the attribute name and the original text. The proposedFix',
    'rewrites ONLY the .view.xml file — do not attempt to edit i18n.properties.',
    '',
    `File: ${args.relPath}`,
    '```xml',
    args.content,
    '```',
    '',
    'Output: {"findings": [Finding, ...]}',
    'Each Finding has:',
    '  - "checkId": "missing-i18n"',
    `  - "file": "${args.relPath}"`,
    '  - "line": <1-based line number of the offending attribute>',
    '  - "message": short description (include the original literal)',
    '  - EITHER',
    '      "proposedFix": {"newFileContent": "<full rewritten view content>"}',
    '    (when the bindings can be introduced safely within the view alone)',
    '    OR',
    '      "proposedFix": null,',
    '      "explanation": "<why this needs human action>"',
    '    (when a safe single-file rewrite is not possible).',
    '',
    'Coalesce all violations in this file into one finding. Return',
    '{"findings": []} if clean.',
  ].join('\n');
}

export const missingI18nCheck: CheckModule = {
  id: 'missing-i18n',
  scope: 'view-xml',
  async run(target, ctx): Promise<CheckResult> {
    const content = await readFile(target, 'utf8');
    const relPath = toPosix(relative(ctx.projectRoot, target));
    const prompt = buildMissingI18nPrompt({ relPath, content });
    const findings = await callLlmForFindings({
      checkId: 'missing-i18n',
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
