import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/output/tty.js';

describe('detectCapabilities', () => {
  it('disables color and spinner on a non-TTY stream', () => {
    const caps = detectCapabilities({ stream: { isTTY: false }, env: {} });
    expect(caps).toEqual({ isTTY: false, useColor: false, useSpinner: false });
  });

  it('enables color and spinner on a TTY without NO_COLOR', () => {
    const caps = detectCapabilities({ stream: { isTTY: true }, env: {} });
    expect(caps).toEqual({ isTTY: true, useColor: true, useSpinner: true });
  });

  it('respects NO_COLOR by disabling color on a TTY', () => {
    const caps = detectCapabilities({
      stream: { isTTY: true },
      env: { NO_COLOR: '1' },
    });
    expect(caps.useColor).toBe(false);
    expect(caps.useSpinner).toBe(false);
  });

  it('respects FORCE_COLOR by enabling color even off a TTY', () => {
    const caps = detectCapabilities({
      stream: { isTTY: false },
      env: { FORCE_COLOR: '1' },
    });
    expect(caps.useColor).toBe(true);
    expect(caps.useSpinner).toBe(false);
  });
});
