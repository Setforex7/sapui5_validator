/**
 * SPEC §2.8 check #1: no direct DOM access in controllers.
 *
 * Flag uses of `document.querySelector`, `document.getElementById`, and
 * jQuery selectors outside `byId()` lookups in `.controller.js` files. The
 * idiomatic replacement is `this.byId("...")` or a control reference held on
 * the controller. Single-file fixes are allowed.
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { ProjectLanguage } from '../project/detect.js';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings, sourceFence, tsSourceGuidance } from './_shared.js';

export function buildNoDirectDomPrompt(args: {
  readonly relPath: string;
  readonly content: string;
  readonly language?: ProjectLanguage;
}): string {
  const language = args.language ?? 'js';
  return [
    'Static check: `no-direct-dom`.',
    '',
    'Inspect this SAPUI5 controller for direct DOM access that should be',
    'replaced with `this.byId(...)` or a stored control reference. Flag uses',
    'of `document.querySelector`, `document.getElementById`, `document.getElementsBy*`,',
    'and jQuery selector calls like `$(...)` or `jQuery(...)` that target DOM',
    'nodes the controller owns. Do NOT flag `byId()` calls or property reads',
    'on framework objects (e.g., `this.getView().byId(...)`).',
    '',
    ...tsSourceGuidance(language),
    `File: ${args.relPath}`,
    '```' + sourceFence(language),
    args.content,
    '```',
    '',
    'Output: a single JSON object',
    '  {"findings": [Finding, ...]}',
    'where each Finding has:',
    '  - "checkId": "no-direct-dom"',
    `  - "file": "${args.relPath}"`,
    '  - "line": <1-based line number where the offending call appears>',
    '  - "message": short description of the violation',
    '  - EITHER',
    '      "proposedFix": {"newFileContent": "<full rewritten file content>"}',
    '    (when the violations can be rewritten safely within this file alone)',
    '    OR',
    '      "proposedFix": null,',
    '      "explanation": "<why this needs human action>"',
    '    (when a safe single-file rewrite is not possible).',
    '',
    'If multiple violations exist in the same file, produce a single finding',
    'whose proposedFix rewrites all of them at once. If the file is clean,',
    'return {"findings": []}.',
  ].join('\n');
}

export const noDirectDomCheck: CheckModule = {
  id: 'no-direct-dom',
  scope: 'controller-js',
  async run(target, ctx): Promise<CheckResult> {
    const content = await readFile(target, 'utf8');
    const relPath = toPosix(relative(ctx.projectRoot, target));
    const prompt = buildNoDirectDomPrompt({
      relPath,
      content,
      language: ctx.projectLanguage ?? 'js',
    });
    const findings = await callLlmForFindings({
      checkId: 'no-direct-dom',
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
