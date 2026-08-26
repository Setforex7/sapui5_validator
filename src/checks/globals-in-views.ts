/**
 * SPEC §2.8 check #6: globals in XML views.
 *
 * Flag bindings or event handlers in `.view.xml` that reference:
 *   - global window properties (`window.X`, undefined globals via dot
 *     notation in formatters);
 *   - controller methods that the paired controller does not define.
 *
 * The view's matching `*.controller.js` is found deterministically here
 * (via the `controllerName="..."` attribute) and embedded in the prompt so
 * the LLM has the membership list to compare against. Single-file fix is
 * usually NOT possible (renaming a handler also touches the controller);
 * the prompt instructs the LLM to return `proposedFix: null` whenever the
 * fix would touch the controller as well.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ProjectLanguage } from '../project/detect.js';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings, sourceFence } from './_shared.js';
import { resolveControllerRelFromView } from '../project/controller-resolve.js';

export function buildGlobalsInViewsPrompt(args: {
  readonly viewRelPath: string;
  readonly viewContent: string;
  readonly controllerRelPath: string | null;
  readonly controllerContent: string | null;
  readonly language?: ProjectLanguage;
}): string {
  // The view itself is XML (language-agnostic — fence unchanged); only the
  // paired-controller reference block follows the project's source language so
  // a TS controller is fenced ` ```typescript ` rather than mislabelled JS.
  const language = args.language ?? 'js';
  const controllerBlock =
    args.controllerRelPath !== null && args.controllerContent !== null
      ? [
          `Paired controller: ${args.controllerRelPath}`,
          '```' + sourceFence(language),
          args.controllerContent,
          '```',
        ]
      : ['No paired controller could be located deterministically.'];
  return [
    'Static check: `globals-in-views`.',
    '',
    'Inspect this SAPUI5 XML view for bindings or event handlers that point',
    'at things the project does not own:',
    '  - `press=".handler"` / `change=".handler"` etc. where `.handler` is',
    '    NOT defined on the paired controller;',
    '  - bindings whose path includes `window.`, `globalThis.`, or any',
    '    other global access expression (`undefined`, `top.`, `parent.`);',
    '  - formatter references to functions not present on the controller',
    '    (or not imported from a known formatter module).',
    'Do NOT flag bindings into a declared model (`{i18n>...}`, `{/path}`,',
    '`{namedModel>/path}`) when no global is involved.',
    '',
    `View: ${args.viewRelPath}`,
    '```xml',
    args.viewContent,
    '```',
    '',
    ...controllerBlock,
    '',
    'Output: {"findings": [Finding, ...]}',
    'Each Finding has:',
    '  - "checkId": "globals-in-views"',
    `  - "file": "${args.viewRelPath}"`,
    '  - "line": <1-based line number in the view>',
    '  - "message": short description',
    '  - EITHER',
    '      "proposedFix": {"newFileContent": "<rewritten view>"}',
    '    (only when the fix is confined to the view file — e.g., removing a',
    '    stray `window.` reference)',
    '    OR',
    '      "proposedFix": null,',
    '      "explanation": "<why this needs both files / human action>"',
    '    (whenever the fix would also need to touch the controller).',
    '',
    'Return {"findings": []} if clean.',
  ].join('\n');
}

export const globalsInViewsCheck: CheckModule = {
  id: 'globals-in-views',
  scope: 'view-xml',
  async run(target, ctx): Promise<CheckResult> {
    const viewContent = await readFile(target, 'utf8');
    const viewRelPath = toPosix(relative(ctx.projectRoot, target));
    const paired = findPairedController(ctx.projectRoot, viewContent);
    const prompt = buildGlobalsInViewsPrompt({
      viewRelPath,
      viewContent,
      controllerRelPath: paired?.relPath ?? null,
      controllerContent: paired?.content ?? null,
      language: ctx.projectLanguage ?? 'js',
    });
    const findings = await callLlmForFindings({
      checkId: 'globals-in-views',
      file: viewRelPath,
      prompt,
      mode: 'auto-fixable-or-manual',
      ctx,
    });
    return { findings };
  },
};

interface PairedController {
  readonly relPath: string;
  readonly content: string;
}

function findPairedController(
  projectRoot: string,
  viewContent: string,
): PairedController | null {
  // COR-6: layout-aware — resolves nested controllers and a `controller`-named
  // namespace segment, not just the flat `webapp/controller/<Name>` the old
  // last-segment heuristic assumed. The resolver gates on file existence.
  const rel = resolveControllerRelFromView({ projectRoot, viewContent });
  if (rel === null) return null;
  return { relPath: rel, content: readFileSync(join(projectRoot, rel), 'utf8') };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
