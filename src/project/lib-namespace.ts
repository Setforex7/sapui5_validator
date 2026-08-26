/**
 * V1.4-4 (AP2) — `libNameFor` extracted from `src/verify/karma.ts` so
 * both the V1.3.3-5 module-load classifier (in `src/verify/karma.ts`)
 * and the V1.4 `ProjectGraph` builder (in
 * `src/project/dependency-graph.ts`) consume one source of truth for
 * UI5 module-ID → library-namespace derivation.
 *
 * Behaviour matches V1.3.3-5 (AH4) for every module whose library prefix is
 * not in {@link KNOWN_SAP_UI5_LIBRARIES}; the V1.5 A1 fix only changes
 * deep-path modules of a known two-segment library (those over-shot the
 * 3-segment cap into a phantom namespace). The existing
 * `test/unit/karma-classify.test.ts` cases are unaffected (none import a deep
 * module of a listed library).
 *
 * V1.3.3-5 (AH4) — opportunistic library-namespace derivation from a UI5
 * module ID. Drops the last `/`-segment (the export name) then, when the prefix
 * is not a known library, caps at 3 segments. The cap conservatively under-shoots into a known top-level
 * library namespace: `sap/ui/comp/smartfield/SmartField` becomes
 * `sap.ui.comp` rather than `sap.ui.comp.smartfield` (a sub-package, not
 * a library karma-ui5 can preload via `client.libs`). The cap would
 * under-shoot 4-segment library namespaces, but the real ones
 * (`sap.suite.ui.commons`) are listed in {@link KNOWN_SAP_UI5_LIBRARIES}
 * and resolved by the longest-prefix loop before the cap fires (R2.4).
 *
 * Returns `null` for 1-segment IDs (no parent library derivable) so the
 * quarantine message can fall back to a generic shape.
 */
export function libNameFor(moduleId: string): string | null {
  const segments = moduleId.split('/');
  if (segments.length < 2) return null;
  // A1 (V1.5): prefer the longest KNOWN SAP UI5 library prefix (a real source of
  // truth) over the blind 3-segment cap, so a deep-module two-segment library
  // (sap/viz/ui5/controls/VizFrame) derives its real library (sap.viz) rather
  // than a phantom (sap.viz.ui5) that would be auto-written to manifest.json and
  // hang karma. The export name (last segment) is never part of a library
  // namespace, so only module-path prefixes are searched. Falls back to the
  // 3-segment cap for any module whose prefix is not a known library — no
  // regression vs. the prior heuristic.
  for (let end = segments.length - 1; end >= 2; end -= 1) {
    const candidate = segments.slice(0, end).join('.');
    if (KNOWN_LIB_SET.has(candidate)) return candidate;
  }
  return segments.slice(0, -1).slice(0, 3).join('.');
}

/**
 * V1.5 (A1) — known SAP UI5 *two-segment* library namespaces whose modules live
 * in deep paths (e.g. `sap/viz/ui5/controls/VizFrame` belongs to `sap.viz`).
 * The 3-segment cap in {@link libNameFor} over-shoots these into a phantom
 * namespace (`sap.viz.ui5`) that is not a real library — and under
 * `--auto-apply-baseline-fixes` (offline, no CDN probe) that phantom is written
 * to `manifest.json`, where karma-ui5 preloads a 404 and hangs at
 * `browserNoActivityTimeout` (the exact failure V1.4 exists to prevent).
 *
 * This list is the real-library source of truth the over-shoot needs:
 * `libNameFor` returns the longest matching entry before falling back to the
 * heuristic, so a deep module of a listed library derives the library, not a
 * phantom.
 *
 * **Any segment count is data, not logic** (R2.4 / AUDIT §5.5). The
 * longest-prefix loop in {@link libNameFor} supports entries of any length, so
 * the table carries whatever real libraries the heuristic mis-derives:
 *   - two-segment deep-path libraries (`sap.viz`, `sap.collaboration`,
 *     `sap.ovp`, `sap.apf`) that the 3-segment cap *over*-shoots into a
 *     phantom (`sap.viz.ui5`), and
 *   - the 4-segment `sap.suite.ui.commons`, which the cap *under*-shoots into
 *     the phantom `sap.suite.ui` (no such library; membership checks in
 *     `dependency-graph.ts` are exact, so even a correct manifest declaration
 *     does not absorb it).
 * Genuine 3-segment libraries (`sap.ui.comp`, `sap.ui.export`) land correctly
 * via the cap and stay out of the table. Add ONLY real SAP UI5 libraries here;
 * a non-library entry would mis-derive and mask a genuine gap. An incomplete
 * table simply falls back to the heuristic (no regression). This is a
 * maintenance surface — extend it as new deep-path libraries are needed.
 *
 * The table doubles as the offline auto-apply source of truth: when no CDN
 * probe ran, `checkUnpreloadedLibs` refuses to write a namespace that is NOT
 * listed here to `manifest.json` (R2.4 — a heuristic-derived phantom written
 * offline is exactly the karma-hang the prevention layer exists to stop).
 */
export const KNOWN_SAP_UI5_LIBRARIES: readonly string[] = Object.freeze([
  'sap.m',
  'sap.f',
  'sap.tnt',
  'sap.uxap',
  'sap.viz',
  'sap.chart',
  'sap.gantt',
  'sap.ndc',
  'sap.ushell',
  'sap.collaboration',
  'sap.ovp',
  'sap.apf',
  'sap.suite.ui.commons',
]);

const KNOWN_LIB_SET = new Set(KNOWN_SAP_UI5_LIBRARIES);
