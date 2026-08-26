/**
 * SEC-5 (V1.8) — strip terminal control / ANSI bytes from a string before it
 * reaches a TTY status line (`output/human.ts`) or an stderr exit message
 * (`output/messages.ts`).
 *
 * Those paths interpolate `file` / `detail` / `lastError` / `message` values
 * that can originate from the LLM or the scanned project. The HTML report path
 * already neutralises them via `escapeHtml`; the terminal path did not, leaving
 * a terminal-escape-injection seam — e.g. a filename containing `\x1b[2J`
 * clearing the screen, or a carriage return rewriting the current line. This
 * helper gives the terminal path the same safety the HTML path already has.
 *
 * It removes every C0 control character (0x00–0x1F: ESC, BEL, BS, CR, LF, TAB),
 * DEL (0x7F), and the C1 control range (0x80–0x9F, which includes the 8-bit CSI
 * 0x9B). Stripping the ESC byte alone already renders a CSI sequence inert —
 * `\x1b[2J` becomes the harmless literal `[2J`. Every character at or above
 * U+00A0 (all normal Unicode text, including accented letters and the
 * non-breaking space) is preserved, so a legitimate multibyte name is never
 * corrupted.
 */

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

export function stripControl(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '');
}
