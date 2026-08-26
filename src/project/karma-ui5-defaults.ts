/**
 * V1.4-4 — populates the V1.4-3 stub. The subset of UI5 library
 * namespaces karma-ui5 makes available regardless of the project's
 * `webapp/manifest.json` `sap.ui5.dependencies.libs` declaration.
 *
 * karma-ui5's preload set is **manifest-driven by default** (per
 * V1.4-PLAN §"Corrections applied to the diagnosis" correction 1):
 * it reads `sap.ui5.dependencies.libs` from the project's manifest
 * and adds those libs to the preload set. If `client.libs` is
 * explicitly set in `karma.conf.js`, it is used as an **override**
 * (not an addition). This constant lists only the libs that are
 * always available regardless of manifest declaration — primarily
 * the bootstrap loader (`sap.ui.core`) and the bundled third-party
 * modules (`sap.ui.thirdparty`, which carries the karma-ui5
 * v3.x-bundled sinon 1.17, qunit, hasher, etc.).
 *
 * Pinned to karma-ui5 v3.x documented behaviour. Future contributors
 * MUST NOT liberalise this list without evidence of additional libs
 * being preloaded unconditionally — adding a lib that isn't actually
 * preloaded would silently mask a real cap_try-shape gap and
 * regress V1.4's core value proposition.
 */
export const KARMA_UI5_ALWAYS_AVAILABLE: readonly string[] = Object.freeze([
  'sap.ui.core',
  'sap.ui.thirdparty',
]);

/**
 * V1.4-9 — module namespaces that are NOT separate UI5 libraries: they
 * ship inside `sap.ui.core`'s bundle and are therefore available
 * whenever `sap.ui.core` is preloaded (which it always is — see
 * {@link KARMA_UI5_ALWAYS_AVAILABLE}). The `libNameFor` 3-segment
 * heuristic derives these as if they were libraries
 * (`sap/ui/model/Filter` → `sap.ui.model`,
 * `sap/base/Log` → `sap.base`, `sap/ui/Device` → `sap.ui`), so without
 * this set the gap computation reports them as unpreloaded and skips /
 * recommends bogus `manifest.json` entries for them.
 *
 * Evidence (cap_try, 2026-05-29): controllers importing only
 * `sap/ui/model/*`, `sap/base/*`, `sap/ui/base/*`, `sap/ui/Device`
 * with a manifest declaring just `sap.m` + `sap.ui.core` LOAD AND PASS
 * under karma-ui5 — proving these namespaces are core-bundled, not
 * separate preloadable libraries. See V1.4-9-DIAGNOSIS.md.
 *
 * This set is the 2-segment `sap.ui` bootstrap namespace plus the
 * well-known `sap/ui/*` and `sap/base/*` core runtime namespaces. It
 * deliberately does NOT include real layered libraries (`sap.ui.layout`,
 * `sap.ui.table`, `sap.ui.unified`, `sap.ui.comp`, `sap.ui.export`, …)
 * — those are 3-segment derivations of genuine libraries and must stay
 * flaggable. Adding a real library here would silently mask a
 * cap_try-shape gap; add only namespaces proven to be core-bundled.
 */
export const SAP_UI_CORE_BUNDLED_NAMESPACES: readonly string[] = Object.freeze([
  'sap.ui',
  'sap.base',
  'sap.ui.base',
  'sap.ui.model',
  'sap.ui.util',
  'sap.ui.dom',
  'sap.ui.events',
  'sap.ui.security',
  'sap.ui.performance',
  'sap.ui.test',
]);

/**
 * V1.9.1 (D3) — the set entries that match by EXACT equality ONLY (never by
 * dotted-prefix). `sap.ui` is the sole such entry: it is the 2-segment
 * bootstrap namespace, but it is also a *prefix* of real, separately
 * preloadable libraries — `sap.ui.table`, `sap.ui.layout`, `sap.ui.comp`,
 * `sap.ui.export`, `sap.ui.unified`, … Prefix-matching `sap.ui` would silently
 * absorb those genuine gaps (the exact false-negative V1.4-9 exists to prevent),
 * so it must stay exact-only. Every other entry (`sap.base`, `sap.ui.model`,
 * `sap.ui.base`, …) is a true namespace root with no real library beneath it,
 * so those legitimately match their dotted descendants too.
 */
const EXACT_ONLY_CORE_NAMESPACES: ReadonlySet<string> = new Set(['sap.ui']);

/**
 * V1.9.1 (D3) — prefix-aware core-bundled-namespace test. A dotted *descendant*
 * of a core-bundled namespace ships inside the same always-preloaded
 * `sap.ui.core` bundle and needs no manifest declaration — e.g.
 * `sap/base/i18n/ResourceBundle` derives (via the `libNameFor` 3-segment cap)
 * to `sap.base.i18n`, a child of the core-bundled `sap.base`. The old
 * exact-membership exclusion in `dependency-graph.ts` was prefix-blind, so that
 * over-shoot slipped through as a false-positive unpreloaded-libs gap on a real
 * TS project (`cap_try_ts` surfaced `sap.base.i18n`; affects JS identically).
 * This helper closes that gap by also matching dotted descendants — guarded by
 * {@link EXACT_ONLY_CORE_NAMESPACES} so `sap.ui`'s real-library children stay
 * flaggable.
 */
export function isCoreBundledNamespace(lib: string): boolean {
  for (const ns of SAP_UI_CORE_BUNDLED_NAMESPACES) {
    if (lib === ns) return true;
    if (!EXACT_ONLY_CORE_NAMESPACES.has(ns) && lib.startsWith(`${ns}.`)) return true;
  }
  return false;
}
