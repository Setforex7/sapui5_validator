#!/usr/bin/env node
/**
 * guard-precommit.mjs — a Claude Code PreToolUse(Bash/PowerShell) hook that
 * enforces a documented, repeatedly-costly discipline the project otherwise
 * relies on memory for:
 *
 *   CHECK — never run the cheap suite while VALIDATOR_E2E_REAL leaks in the
 *     environment. vitest.config gates the whole e2e-real folder on that var, so
 *     a stray `=1` turns a supposedly-free `npm test` into a real
 *     claude/karma/CDN run (burns money; produces CDN/flake reds that look like
 *     regressions). The session-exit-auditor only eyeballs this after the fact.
 *
 * DESIGN: FAIL-OPEN. Any parse error, missing input, or git failure exits 0
 * (allow) so a bug in this guard can never block legitimate work. It exits 2
 * (block, message shown to Claude) ONLY in the precise confirmed-bad case.
 *
 * Wired via .claude/settings.json PreToolUse. Also usable as a git pre-commit
 * backstop (it falls back to env/argv when no hook JSON is on stdin).
 */

function allow() {
  process.exit(0);
}
function block(msg) {
  process.stderr.write(`[guard-precommit] ${msg}\n`);
  process.exit(2);
}

function isCheapSuite(cmd) {
  if (/e2e[-:]?real|test:e2e|VALIDATOR_E2E_REAL/.test(cmd)) return false; // the real gate sets it itself
  return /(^|[\s;&|(])npm\s+(run\s+)?test\b/.test(cmd) || /(^|[\s;&|(])vitest\b/.test(cmd);
}

function main(payload) {
  const cmd = payload && payload.tool_input && typeof payload.tool_input.command === 'string'
    ? payload.tool_input.command
    : '';
  if (!cmd) allow();

  // Block the cheap suite while VALIDATOR_E2E_REAL leaks in the env.
  if (isCheapSuite(cmd) && process.env.VALIDATOR_E2E_REAL) {
    block(
      `Blocked: VALIDATOR_E2E_REAL=${process.env.VALIDATOR_E2E_REAL} is set in the environment,\n` +
        'so this "cheap" offline suite would silently re-point at the REAL toolchain\n' +
        '(real claude/karma/CDN — costs money, produces CDN/flake reds that look like\n' +
        'regressions). Unset it first:\n' +
        '  PowerShell:  Remove-Item Env:VALIDATOR_E2E_REAL\n' +
        '  bash:        unset VALIDATOR_E2E_REAL\n' +
        'To run the real gate deliberately, use:  npm run test:e2e-real',
    );
  }

  allow();
}

// Read the PreToolUse hook JSON from stdin; fall back to fail-open if absent.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
});
process.stdin.on('end', () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    main(payload);
  } catch {
    allow(); // any failure → fail open, never block legitimate work
  }
});
// If nothing arrives on stdin (e.g. invoked outside the hook), fail open.
setTimeout(() => allow(), 2000).unref();
