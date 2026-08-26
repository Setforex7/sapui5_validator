import { describe, expect, it } from 'vitest';
import {
  concurrencyBanner,
  formatPhaseLine,
  formatPhaseProgress,
  formatStatusLine,
  generatedTestStatusLine,
  verificationBanner,
  verificationDetail,
} from '../../src/output/human.js';
import type { ReportGeneratedTest } from '../../src/types.js';

describe('formatStatusLine', () => {
  it('renders a plain status line without color', () => {
    const line = formatStatusLine(
      { tag: 'OK', file: 'webapp/controller/Main.controller.js' },
      false,
    );
    expect(line).toContain('[OK]');
    expect(line).toContain('webapp/controller/Main.controller.js');
    expect(line).not.toContain('\x1b[');
  });

  it('includes detail when provided', () => {
    const line = formatStatusLine(
      { tag: 'FIX', file: 'a.js', detail: 'no-direct-dom' },
      false,
    );
    expect(line).toContain('[FIX]');
    expect(line).toContain('no-direct-dom');
  });

  it('emits ANSI escapes when useColor is true', () => {
    const line = formatStatusLine({ tag: 'FAIL', file: 'a.js' }, true);
    expect(line).toMatch(/\x1b\[/);
  });
});

// SEC-5 (V1.8) — `file`/`detail` can carry LLM/project-derived text. Terminal
// control/ANSI bytes must be rendered inert (parity with the HTML path), or a
// crafted filename could clear the screen / rewrite the line. Fails on revert:
// drop the stripControl calls and the ESC byte survives into the output.
describe('formatStatusLine — SEC-5 control-char stripping', () => {
  it('strips an ESC-based CSI sequence from the file, leaving inert text', () => {
    const line = formatStatusLine(
      { tag: 'OK', file: 'webapp/\x1b[2JEvil.controller.js' },
      false,
    );
    expect(line).not.toContain('\x1b');
    // The ESC byte is gone; the remaining literal `[2J` is harmless.
    expect(line).toContain('webapp/[2JEvil.controller.js');
  });

  it('strips control bytes (CR, BEL, C1 CSI) from the detail', () => {
    const line = formatStatusLine(
      { tag: 'FIX', file: 'a.js', detail: 'no-direct\rdom\x07\x9b31m' },
      false,
    );
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).toContain('no-directdom31m');
  });

  it('preserves legitimate non-ASCII (accented) characters', () => {
    const line = formatStatusLine({ tag: 'OK', file: 'wébapp/Café.js' }, false);
    expect(line).toContain('wébapp/Café.js');
  });
});

// V1.9.2 (TG-REPORT / FS-8) — the never-silent-green detail mapping + the
// per-generated-test status line. This is the CLI-half guard: `cli.ts` only
// wires `generatedTestStatusLine`, so reverting the `static-only` branch here
// (or the detail string) goes RED without needing CLI-output capture.
describe('verificationDetail', () => {
  it('maps lint-only to the not-executed detail', () => {
    expect(verificationDetail('lint-only')).toBe('(lint-only — not executed by karma)');
  });

  it('maps static-only to the type-checked-not-executed detail', () => {
    expect(verificationDetail('static-only')).toBe(
      '(static-only — type-checked + linted, not executed by karma)',
    );
  });

  it('returns undefined for a fully-executed (unmarked) pass', () => {
    expect(verificationDetail(undefined)).toBeUndefined();
  });
});

// V1.9.3 (D1) — the run-level `validate` banner. `cli.ts` is trivial wiring
// (it writes whatever this returns), so this is the authoritative guard that a
// `'lint-only'` run still gets an HONEST, NON-EMPTY banner and that the
// `'static-only'` banner alone claims the `tsc --noEmit` type-check. The D1 trap
// this guards: emitting `'lint-only'` while `cli.ts` kept a `=== 'static-only'`
// check would silently DROP the banner. Reverting the `'lint-only'` arm here →
// `undefined` → these assertions go RED.
describe('verificationBanner (V1.9.3 D1)', () => {
  it('a static-only run banner is emitted and claims the tsc --noEmit type-check', () => {
    const banner = verificationBanner('static-only');
    expect(banner).toBeDefined();
    expect(banner).toContain('static-only');
    expect(banner).toContain('tsc --noEmit');
    expect(banner).toContain('karma not run');
  });

  it('a lint-only run banner is EMITTED (never dropped) and does NOT claim a tsc type-check', () => {
    const banner = verificationBanner('lint-only');
    expect(banner).toBeDefined();
    expect(banner).toContain('lint-only');
    // The honesty heart of D1: a tsc-skipped run must not claim "type-checked".
    expect(banner).not.toContain('tsc --noEmit');
    expect(banner).not.toContain('type-check');
    // Still records the firewall (karma never ran).
    expect(banner).toContain('karma not run');
  });

  it('a JS run (no marker) → no banner', () => {
    expect(verificationBanner(undefined)).toBeUndefined();
  });
});

// V1.9.7 (THR-1) — cli.ts renderResult wires `concurrencyBanner`; reverting the
// `<= 1` guard or the wording here goes RED without needing CLI-output capture.
describe('concurrencyBanner (V1.9.7 THR-1)', () => {
  it('K>1 → a banner stating the effective width and the sequential opt-out', () => {
    const banner = concurrencyBanner(2);
    expect(banner).toBeDefined();
    expect(banner).toContain('concurrency: 2');
    expect(banner).toContain('--concurrency 1');
  });

  it('a higher K is reflected verbatim', () => {
    expect(concurrencyBanner(4)).toContain('concurrency: 4');
  });

  it('K=1 (sequential) → no banner (output stays byte-identical to pre-THR-1)', () => {
    expect(concurrencyBanner(1)).toBeUndefined();
  });

  it('absent concurrency → no banner', () => {
    expect(concurrencyBanner(undefined)).toBeUndefined();
  });
});

describe('generatedTestStatusLine', () => {
  const base = (over: Partial<ReportGeneratedTest>): ReportGeneratedTest => ({
    sourceFile: 'webapp/controller/App.controller.ts',
    testFile: 'webapp/test/unit/controller/App.controller.qunit.ts',
    status: 'passed',
    ...over,
  });

  it('a static-only TS QUnit pass → GEN tag + the static-only detail', () => {
    const line = generatedTestStatusLine(base({ verification: 'static-only' }));
    expect(line.tag).toBe('GEN');
    expect(line.detail).toBe(
      '(static-only — type-checked + linted, not executed by karma)',
    );
  });

  it('a karma-executed pass (no marker) → GEN tag, no detail', () => {
    const line = generatedTestStatusLine(base({}));
    expect(line.tag).toBe('GEN');
    expect(line.detail).toBeUndefined();
  });

  it('a quarantined entry → FAIL tag, no verification detail', () => {
    const line = generatedTestStatusLine(base({ status: 'quarantined' }));
    expect(line.tag).toBe('FAIL');
    expect(line.detail).toBeUndefined();
  });

  it('a skipped-baseline entry → SKIP tag', () => {
    expect(generatedTestStatusLine(base({ status: 'skipped-baseline' })).tag).toBe('SKIP');
  });
});

describe('formatPhaseLine', () => {
  it('renders the phase and file', () => {
    const line = formatPhaseLine(
      { file: 'a.js', phase: 'verify', durationMs: 123 },
      false,
    );
    expect(line).toContain('verify');
    expect(line).toContain('a.js');
    expect(line).toContain('(123ms)');
  });
});

describe('formatPhaseProgress', () => {
  it('renders the phase label and the message', () => {
    const line = formatPhaseProgress({
      phase: 'baseline lint',
      message: 'linting 4 in-scope files…',
    });
    expect(line).toContain('baseline lint');
    expect(line).toContain('linting 4 in-scope files…');
  });

  it('appends the elapsed time when durationMs is given', () => {
    const line = formatPhaseProgress({
      phase: 'baseline karma',
      message: 'done',
      durationMs: 1234,
    });
    expect(line).toContain('baseline karma');
    expect(line).toContain('done');
    expect(line).toContain('(1234ms)');
  });

  it('omits the elapsed time when durationMs is absent', () => {
    const line = formatPhaseProgress({ phase: 'p', message: 'm' });
    expect(line).not.toMatch(/\(\d+ms\)/);
  });
});
