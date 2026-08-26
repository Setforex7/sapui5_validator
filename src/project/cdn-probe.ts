/**
 * V1.4-10 — best-effort probe of whether a UI5 library is served by the
 * karma test CDN (karma-ui5's `ui5.url`).
 *
 * Motivation (cap_try, 2026-05-29): `sap.ui.export` is a SAPUI5-only
 * library. The cap_try `karma.conf.js` points karma-ui5 at the OpenUI5
 * CDN (`https://sdk.openui5.org`), which does NOT ship `sap.ui.export`
 * (404), so karma's preload of a manifest-declared `sap.ui.export` hangs
 * at `browserNoActivityTimeout`. Declaring the lib in `manifest.json`
 * therefore does NOT fix the test — the only test-side remedy is to
 * pre-register a stub for the module. This probe lets the
 * `baseline-unpreloaded-libs` check tell the two cases apart:
 *   - CDN serves the lib  → manifest auto-fix is valid (preload-fixable).
 *   - CDN 404s the lib     → stub-only; do not add to the manifest.
 *
 * Behaviour boundaries:
 *   - **Best-effort on network uncertainty, never throws for it.** Network
 *     errors, timeouts, non-404 non-200 responses, or a refused redirect all
 *     resolve to `true` (assume served). `true` is the conservative default:
 *     it preserves the pre-V1.4-10 behaviour (offer the manifest fix) rather
 *     than wrongly steering every lib to a stub when the network is
 *     unavailable (e.g. offline CI).
 *   - **SSRF guard (SEC-2, V1.8).** `ui5.url` comes from the untrusted
 *     `karma.conf.js`. Before any network call the probe validates the target:
 *     the scheme must be `http:`/`https:`, and the host must not be a
 *     loopback / private / link-local / cloud-metadata address. A violation
 *     throws {@link UnsafeProbeTargetError} — a deliberate refusal distinct
 *     from best-effort network uncertainty — WITHOUT touching the network.
 *     The caller ({@link import('./dependency-graph.js')}) already maps any
 *     throw to `cdnServed: true, cdnProbed: false` (unprobed, conservatively
 *     assume served), so a hostile `ui5.url` neither performs an internal
 *     request nor regresses the offline path. Redirects are never followed
 *     (`redirect: 'error'`) so a public host cannot bounce the probe to an
 *     internal target.
 *   - **Injectable transport.** `fetchImpl` defaults to the global
 *     `fetch` (Node 20+). Unit tests inject a fake so the suite stays
 *     offline and deterministic; production passes nothing.
 *   - **One request per (url, lib).** The caller is responsible for not
 *     probing the same lib twice; this module holds no cache.
 */

import { isIP } from 'node:net';

export type FetchLike = (
  input: string,
  init?: { method?: string; redirect?: 'error' | 'follow' | 'manual'; signal?: AbortSignal },
) => Promise<{ status: number }>;

const PROBE_TIMEOUT_MS = 8000;

/**
 * SEC-2 — thrown when a CDN-probe target fails the SSRF guard (non-http(s)
 * scheme, or a loopback/private/link-local/metadata host). A named, deliberate
 * refusal raised BEFORE any network call; the dependency-graph caller maps it
 * to the conservative `cdnServed: true, cdnProbed: false` (unprobed) outcome.
 */
export class UnsafeProbeTargetError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`refusing to probe an unsafe CDN target (${reason}): ${url}`);
    this.name = 'UnsafeProbeTargetError';
    this.url = url;
    this.reason = reason;
    Object.setPrototypeOf(this, UnsafeProbeTargetError.prototype);
  }
}

/**
 * Map a UI5 library namespace to the library-preload resource karma-ui5
 * would request: `sap.ui.export` → `sap/ui/export/library-preload.js`.
 * The library-preload module is the right probe target because karma-ui5
 * preloads libraries via it; a 404 there is exactly the failure the test
 * runtime hits.
 */
export function libPreloadResourcePath(lib: string): string {
  return `${lib.replace(/\./g, '/')}/library-preload.js`;
}

/**
 * Resolve `<ui5Url>/resources/<lib-preload-path>`. Tolerates a trailing
 * slash on the configured URL.
 */
function libPreloadUrl(ui5Url: string, lib: string): string {
  const base = ui5Url.replace(/\/+$/u, '');
  return `${base}/resources/${libPreloadResourcePath(lib)}`;
}

/**
 * SEC-2 — refuse a probe target whose scheme is not http(s) or whose host is
 * not publicly routable. Throws {@link UnsafeProbeTargetError} on any
 * violation; returns normally otherwise. Pure (no network).
 *
 * For special schemes, the WHATWG `URL` parser already normalises every IPv4
 * spelling (dotted-decimal, integer `2130706433`, hex `0x7f000001`, octal) to
 * canonical dotted-decimal in `hostname`, so the octet checks below catch the
 * obfuscated forms too. A bare DNS name is allowed — it may resolve to a public
 * host, and `redirect: 'error'` blocks a redirect-to-internal bounce.
 */
export function assertSafeProbeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeProbeTargetError(rawUrl, 'not a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeProbeTargetError(rawUrl, `unsupported scheme "${parsed.protocol}"`);
  }
  // IPv6 literals arrive bracketed (`[::1]`); strip for classification.
  const host = parsed.hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
  if (isUnsafeProbeHost(host)) {
    throw new UnsafeProbeTargetError(rawUrl, `non-public host "${host}"`);
  }
}

function isUnsafeProbeHost(host: string): boolean {
  if (host.length === 0) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // GCP metadata DNS alias (the IP form 169.254.169.254 is caught below).
  if (host === 'metadata.google.internal') return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) return isPrivateIpv6(host);
  return false; // a DNS name resolving to a public host
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map((n) => Number(n));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → fail closed
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  // Classify by the fully-expanded 8-hextet form, not by string prefix. The
  // WHATWG URL parser normalises an IPv4-mapped literal to its hex-compressed
  // shape (`[::ffff:127.0.0.1]` → `::ffff:7f00:1`), so a dotted-decimal regex
  // would miss loopback/metadata reached via dual-stack IPv6 (SEC-2 bypass).
  const g = expandIpv6(ip);
  if (g === null) return true; // isIP() said v6 but we can't parse it → fail closed
  if (g.every((h) => h === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((h) => h === 0) && g[7] === 1) return true; // ::1 loopback
  const [g0, , , , g4, g5, g6, g7] = g as [
    number, number, number, number, number, number, number, number,
  ];
  const headZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g4 === 0;
  const isMapped = headZero && g5 === 0xffff; // ::ffff:a.b.c.d (IPv4-mapped)
  const isCompat = headZero && g5 === 0; // ::a.b.c.d (deprecated IPv4-compatible)
  const isNat64 = // 64:ff9b::/96 well-known NAT64 prefix
    g0 === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g4 === 0 && g5 === 0;
  if (isMapped || isCompat || isNat64) {
    const embedded = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateIpv4(embedded);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * Expand an IPv6 literal (lowercased, brackets already stripped) to its 8
 * hextets, resolving `::` compression and an embedded dotted-IPv4 tail. Returns
 * `null` for anything it cannot parse; the caller fails closed on `null`.
 */
function expandIpv6(addr: string): number[] | null {
  const noZone = addr.split('%')[0] ?? addr; // drop any %zone-id
  const halves = noZone.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const tokens = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok === undefined) return null;
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return null; // dotted IPv4 only valid last
        const octs = tok.split('.').map((o) => Number(o));
        if (octs.length !== 4 || octs.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        out.push(((octs[0]! << 8) | octs[1]!) & 0xffff, ((octs[2]! << 8) | octs[3]!) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  if (halves.length === 1) {
    const g = parseGroups(halves[0] ?? '');
    return g !== null && g.length === 8 ? g : null;
  }
  const head = parseGroups(halves[0] ?? '');
  const tail = parseGroups(halves[1] ?? '');
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // `::` stands for at least one zero group
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * True when the lib appears to be served by the configured karma CDN.
 * Best-effort: any uncertainty resolves to `true` (see module note).
 */
export async function probeLibServed(
  ui5Url: string,
  lib: string,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const doFetch: FetchLike | undefined =
    fetchImpl ??
    (typeof fetch === 'function'
      ? (input, init) => fetch(input, init)
      : undefined);
  if (doFetch === undefined) return true; // no transport — assume served
  const url = libPreloadUrl(ui5Url, lib);
  // SEC-2 — validate scheme + host BEFORE any network call. A violation throws
  // and propagates (the caller records it as unprobed/assume-served); it is NOT
  // caught by the best-effort handler below.
  assertSafeProbeUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'HEAD',
      // SEC-2 — never follow a redirect to a (possibly internal) target.
      redirect: 'error',
      signal: controller.signal,
    });
    // Only a definitive 404/410 marks the lib as NOT served. Any other
    // status (200, 3xx, 5xx, proxy quirks) is treated as served so a
    // transient server-side issue never wrongly forces the stub path.
    return !(res.status === 404 || res.status === 410);
  } catch {
    return true; // network error / timeout — assume served
  } finally {
    clearTimeout(timer);
  }
}
