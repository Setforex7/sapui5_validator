/**
 * V1.4-10 witnesses — pin `probeLibServed`'s best-effort contract and the
 * library-preload resource mapping. The transport is injected so the suite
 * stays offline.
 */

import { describe, expect, test } from 'vitest';
import {
  assertSafeProbeUrl,
  libPreloadResourcePath,
  probeLibServed,
  UnsafeProbeTargetError,
  type FetchLike,
} from '../../src/project/cdn-probe.js';

const URL = 'https://sdk.openui5.org';

function fetchReturning(status: number, capture?: (url: string) => void): FetchLike {
  return async (input) => {
    capture?.(input);
    return { status };
  };
}

interface SpyCall {
  readonly url: string;
  readonly init?: {
    method?: string;
    redirect?: 'error' | 'follow' | 'manual';
    signal?: AbortSignal;
  };
}

function spyFetch(status = 200): { fetch: FetchLike; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, ...(init !== undefined ? { init } : {}) });
    return { status };
  };
  return { fetch, calls };
}

describe('libPreloadResourcePath', () => {
  test('maps a lib namespace to its library-preload resource', () => {
    expect(libPreloadResourcePath('sap.ui.export')).toBe(
      'sap/ui/export/library-preload.js',
    );
    expect(libPreloadResourcePath('sap.f')).toBe('sap/f/library-preload.js');
  });
});

describe('probeLibServed — best-effort CDN availability', () => {
  test('HTTP 200 → served (true), and requests the resources/<lib>/library-preload.js URL', () => {
    let requested = '';
    return probeLibServed(
      URL,
      'sap.ui.export',
      fetchReturning(200, (u) => {
        requested = u;
      }),
    ).then((served) => {
      expect(served).toBe(true);
      expect(requested).toBe(
        'https://sdk.openui5.org/resources/sap/ui/export/library-preload.js',
      );
    });
  });

  test('HTTP 404 → NOT served (false)', async () => {
    expect(await probeLibServed(URL, 'sap.ui.export', fetchReturning(404))).toBe(
      false,
    );
  });

  test('HTTP 410 → NOT served (false)', async () => {
    expect(await probeLibServed(URL, 'sap.ui.export', fetchReturning(410))).toBe(
      false,
    );
  });

  test('HTTP 500 → assume served (true) — only a definitive 404/410 forces the stub path', async () => {
    expect(await probeLibServed(URL, 'sap.ui.export', fetchReturning(500))).toBe(
      true,
    );
  });

  test('a throwing transport (network error / timeout) → assume served (true)', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await probeLibServed(URL, 'sap.ui.export', boom)).toBe(true);
  });

  test('tolerates a trailing slash on the configured URL', () => {
    let requested = '';
    return probeLibServed(
      'https://sdk.openui5.org/',
      'sap.f',
      fetchReturning(200, (u) => {
        requested = u;
      }),
    ).then(() => {
      expect(requested).toBe(
        'https://sdk.openui5.org/resources/sap/f/library-preload.js',
      );
    });
  });
});

describe('probeLibServed — SEC-2 SSRF guard', () => {
  // `ui5.url` originates from the untrusted karma.conf.js. Each of these must be
  // refused BEFORE any network call (assert: zero fetches) so the probe cannot
  // be turned into a server-side request forgery.
  const unsafe: ReadonlyArray<readonly [string, string]> = [
    ['cloud-metadata IP (169.254.169.254)', 'http://169.254.169.254'],
    ['localhost', 'http://localhost:8080'],
    ['IPv4 loopback', 'http://127.0.0.1'],
    ['private 10.0.0.0/8', 'http://10.0.0.5'],
    ['private 192.168.0.0/16', 'http://192.168.1.1'],
    ['private 172.16.0.0/12', 'http://172.16.5.5'],
    ['CGNAT 100.64.0.0/10', 'http://100.64.0.1'],
    ['IPv6 loopback ([::1])', 'http://[::1]'],
    ['IPv6 link-local ([fe80::1])', 'http://[fe80::1]'],
    ['IPv6 unique-local ([fc00::1])', 'http://[fc00::1]'],
    ['IPv6 unique-local ([fd12::1])', 'http://[fd12::1]'],
    // IPv4-mapped / -compatible IPv6 — these normalise to a hex form
    // (::ffff:a9fe:a9fe), the SEC-2 dual-stack bypass the audit found.
    ['IPv4-mapped loopback ([::ffff:127.0.0.1])', 'http://[::ffff:127.0.0.1]'],
    ['IPv4-mapped metadata ([::ffff:169.254.169.254])', 'http://[::ffff:169.254.169.254]'],
    ['IPv4-mapped private ([::ffff:10.0.0.1])', 'http://[::ffff:10.0.0.1]'],
    ['IPv4-compatible loopback ([::127.0.0.1])', 'http://[::127.0.0.1]'],
    ['NAT64 well-known ([64:ff9b::7f00:1])', 'http://[64:ff9b::7f00:1]'],
    ['integer-encoded loopback (2130706433 = 127.0.0.1)', 'http://2130706433'],
    ['non-http scheme (file:)', 'file:///etc/passwd'],
    ['non-http scheme (ftp:)', 'ftp://attacker.example'],
  ];

  for (const [label, badUrl] of unsafe) {
    test(`refuses ${label} without any fetch`, async () => {
      const { fetch, calls } = spyFetch();
      await expect(probeLibServed(badUrl, 'sap.ui.export', fetch)).rejects.toThrow(
        UnsafeProbeTargetError,
      );
      expect(calls).toHaveLength(0);
    });
  }

  test('a public https URL passes the guard, IS fetched, and never follows redirects', async () => {
    const { fetch, calls } = spyFetch(200);
    const served = await probeLibServed('https://sdk.openui5.org', 'sap.ui.export', fetch);
    expect(served).toBe(true);
    expect(calls).toHaveLength(1);
    // redirect:'error' is the structural defense against a public host
    // bouncing the probe to an internal target.
    expect(calls[0]?.init?.redirect).toBe('error');
  });

  test('a public DNS name is allowed (only IP-literal private ranges are blocked)', async () => {
    const { fetch, calls } = spyFetch(200);
    await expect(
      probeLibServed('https://cdn.example.com', 'sap.f', fetch),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('a public IPv6 literal is allowed (no over-blocking)', async () => {
    const { fetch, calls } = spyFetch(200);
    await expect(
      probeLibServed('https://[2606:4700::1111]', 'sap.f', fetch),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('assertSafeProbeUrl', () => {
  test('accepts public http/https targets', () => {
    expect(() =>
      assertSafeProbeUrl('https://sdk.openui5.org/resources/sap/f/library-preload.js'),
    ).not.toThrow();
    expect(() => assertSafeProbeUrl('http://cdn.example.com/resources/x.js')).not.toThrow();
  });

  test('rejects non-public hosts and non-http schemes', () => {
    const bad = [
      'http://127.0.0.1/x',
      'http://10.0.0.1/x',
      'http://169.254.169.254/x',
      'http://[::1]/x',
      'http://[fd12::1]/x',
      'file:///etc/passwd',
      'ftp://host/x',
      'not-a-url',
    ];
    for (const u of bad) {
      expect(() => assertSafeProbeUrl(u), u).toThrow(UnsafeProbeTargetError);
    }
  });
});
