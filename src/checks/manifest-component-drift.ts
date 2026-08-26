/**
 * SPEC §2.8 check #5: manifest / Component drift.
 *
 * Detect mismatches between `webapp/manifest.json` and `webapp/Component.js`:
 * routes/targets/models/dataSources that are declared in the manifest but
 * not referenced in Component.js (or wired in Component.js but missing from
 * manifest). Multi-file fix → `proposedFix: null` + explanation, per
 * SPEC §2.8 / §2.9.
 *
 * The manifest and Component contents are read DETERMINISTICALLY here and
 * embedded in the prompt. The LLM only categorises the drift — it does not
 * decide whether to read these files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckModule, CheckResult } from './types.js';
import { callLlmForFindings } from './_shared.js';

const MANIFEST_REL = 'webapp/manifest.json';
const COMPONENT_JS_REL = 'webapp/Component.js';
const COMPONENT_TS_REL = 'webapp/Component.ts';

export function buildManifestDriftPrompt(args: {
  readonly manifest: string;
  readonly component: string;
  /**
   * V1.9 — the project-relative Component path embedded in the prompt headers.
   * Defaults to `webapp/Component.js` so the JS prompt is byte-identical; a TS
   * project passes `webapp/Component.ts` (the entrypoint is `Component.ts`).
   */
  readonly componentRel?: string;
}): string {
  const componentRel = args.componentRel ?? COMPONENT_JS_REL;
  return [
    'Static check: `manifest-component-drift`.',
    '',
    `Given the project's \`webapp/manifest.json\` and \`${componentRel}\`,`,
    'identify drift between declarations and wiring. Look for:',
    '  - Routes or targets declared under `sap.ui5.routing` in the manifest',
    '    that are never referenced from Component.js (e.g., `getRouter()`',
    '    handling, target activation), or vice versa.',
    '  - Models or dataSources declared in the manifest that the component',
    '    never sets up / consumes, or models attached in Component.js that',
    '    are absent from the manifest.',
    '  - Mismatched names (typos, case drift) between the two files.',
    'Do NOT flag a route whose handling is the implicit default routing',
    'initialiser (`this.getRouter().initialize()` covers all manifest routes).',
    '',
    'Every finding MUST be multi-file — set `proposedFix` to `null` and put',
    'the human-readable rationale in `explanation`.',
    '',
    '----- webapp/manifest.json -----',
    args.manifest,
    `----- ${componentRel} -----`,
    args.component,
    '----- end -----',
    '',
    'Output: {"findings": [Finding, ...]}',
    'Each Finding has:',
    '  - "checkId": "manifest-component-drift"',
    `  - "file": one of "webapp/manifest.json" or "${componentRel}"`,
    '    (whichever is the better anchor for the human reader)',
    '  - "line": <1-based line number if known, otherwise omit>',
    '  - "message": short description',
    '  - "proposedFix": null',
    '  - "explanation": full rationale + recommended human action',
    '',
    'Return {"findings": []} if no drift is detected.',
  ].join('\n');
}

export const manifestComponentDriftCheck: CheckModule = {
  id: 'manifest-component-drift',
  scope: 'project',
  async run(target, ctx): Promise<CheckResult> {
    const manifestPath = join(target, MANIFEST_REL);
    // V1.9 — dual-suffix Component resolution: `.js` first (JS byte-identical),
    // then `.ts` (a TS project ships `Component.ts`). Without the `.ts` arm this
    // check silently no-ops on every TS project (no `Component.js` on disk).
    const componentRel = existsSync(join(target, COMPONENT_JS_REL))
      ? COMPONENT_JS_REL
      : COMPONENT_TS_REL;
    const componentPath = join(target, componentRel);
    if (!existsSync(manifestPath) || !existsSync(componentPath)) {
      // Project detection already accepts a ui5.yaml-only project where these
      // files may be missing. In that case the check has nothing to compare
      // and returns no findings — the orchestrator decides whether to run it.
      return { findings: [] };
    }
    const manifest = readFileSync(manifestPath, 'utf8');
    const component = readFileSync(componentPath, 'utf8');
    const prompt = buildManifestDriftPrompt({ manifest, component, componentRel });
    const findings = await callLlmForFindings({
      checkId: 'manifest-component-drift',
      file: componentRel,
      prompt,
      mode: 'manual-only',
      ctx,
    });
    return { findings };
  },
};
