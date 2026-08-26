/**
 * V1.2-1 (Feature 1, Session V1.2-1) — interactive menu that lets the user
 * accept or override the LLM call budget before any LLM call is made.
 *
 * Wired into `validate` from `src/commands/validate.ts` after scope
 * resolution and before the baseline+check phase. The menu is only shown
 * when `estimate.recommended > currentLimit` (see the orchestrator);
 * otherwise it never appears and the user is not bothered.
 *
 * The implementation deliberately uses Node's built-in `readline` (no
 * `inquirer`-style dependency) — see CLAUDE.md "Avoid: new dependencies".
 *
 * Test injection: `promptCallLimitChoice` accepts an optional `io` object
 * that overrides the default `process.stdin` / `process.stdout` /
 * `process.stderr` wiring. Unit tests pass a paired Readable + memory
 * Writable so the menu can be driven entirely in-process.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { DEFAULT_LLM_BUDGET } from '../claude/budget.js';

export type MenuAction = 'continue' | 'accept' | 'custom' | 'cancel';

export interface MenuChoice {
  readonly action: MenuAction;
  readonly newLimit?: number;
}

export interface MenuIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /**
   * Whether the input is connected to an interactive terminal. When false the
   * menu skips itself and returns `{ action: 'continue' }` so CI runs do not
   * block on stdin — `--no-prompt` is the explicit opt-out, this is the
   * implicit one.
   */
  readonly isTty: boolean;
}

/**
 * Subset of {@link import('./estimator.js').CallEstimate} the menu actually
 * reads. Tests can pass the minimal `{ minimum, recommended }` shape; the
 * orchestrator passes the full estimate (which carries `totalFiles` +
 * `checkCategories` for the header line).
 */
export interface EstimateBounds {
  readonly minimum: number;
  readonly recommended: number;
  readonly totalFiles?: number;
  readonly checkCategories?: number;
}

/** Hard upper cap protects against typos like `30000` in custom-limit input. */
export const CUSTOM_LIMIT_MAX = 2000;

const MAX_PROMPT_RETRIES = 3;

export async function promptCallLimitChoice(
  currentLimit: number,
  recommended: number,
  estimate: EstimateBounds,
  io: MenuIo = defaultIo(),
  /**
   * V1.3.1-5 — optional caller-supplied first line of the menu. `validate`
   * leaves it unset and gets the verbatim file/check-category header;
   * `generate` passes a candidate-based string (its scope is not
   * check-category-shaped). Purely additive — the default is unchanged.
   */
  headerOverride?: string,
  /**
   * V1.9.7 (THR-1) — the EFFECTIVE dispatch width this run will use (after any
   * lane-safety downgrade the command already resolved). Rendered as one menu
   * line when > 1 so the user sees the run is parallel before choosing a
   * budget. Unset / 1 renders nothing (the sequential path is silent, keeping
   * pre-THR-1 menu output byte-identical).
   */
  effectiveConcurrency?: number,
): Promise<MenuChoice> {
  if (!io.isTty) {
    io.stderr.write(
      'sapui5-validate: non-interactive stdin detected; ' +
        'keeping current LLM call limit. Pass --max-llm-calls <N> to override.\n',
    );
    return { action: 'continue' };
  }

  renderMainMenu(
    io.stdout,
    currentLimit,
    recommended,
    estimate,
    {
      totalFiles: estimate.totalFiles ?? 0,
      checkCategories: estimate.checkCategories ?? 0,
    },
    headerOverride,
    effectiveConcurrency,
  );

  const reader = makeLineReader(io.stdin);
  try {
    for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt += 1) {
      io.stdout.write('Choose [1-4]: ');
      const line = await reader.next();
      if (line === null) return { action: 'cancel' };
      const choice = line.trim();
      switch (choice) {
        case '1':
          return { action: 'continue' };
        case '2':
          return { action: 'accept', newLimit: recommended };
        case '3':
          return await promptCustomLimit(io, reader, estimate);
        case '4':
          return { action: 'cancel' };
        default:
          io.stderr.write(
            `Invalid choice "${choice}". Enter 1, 2, 3, or 4.\n`,
          );
      }
    }
    io.stderr.write(
      `Too many invalid responses (${MAX_PROMPT_RETRIES}); cancelling.\n`,
    );
    return { action: 'cancel' };
  } finally {
    reader.close();
  }
}

/**
 * V1.9.4 PERF-17 — the opt-in per-run model choice. `model` is the user-supplied
 * id to forward via `--model`, or `undefined` to keep the Claude Code default
 * (no `--model` emitted). Free-form BY DESIGN: the menu never names or pins a
 * model id, so CLAUDE.md's "no model ID in code" holds with zero exceptions
 * (decision §11.8(a) — the flag and the menu both stay model-name-free in `src/`).
 */
export interface ModelChoice {
  readonly model?: string;
}

/**
 * V1.9.4 PERF-17 — interactive per-run model picker, mirroring
 * {@link promptCallLimitChoice}: it rides the same "this run is large" moment the
 * call-limit menu fires on, shares the {@link MenuIo} seam, and a non-TTY stdin
 * short-circuits to the default (CI never silently downgrades). The CALLER also
 * skips it when `--no-prompt` is set or an explicit `--model` was already
 * supplied — this function only owns the non-TTY short-circuit and the render.
 *
 * The model is the single biggest cost lever (a cheaper tier ≈5–15× less) but a USER
 * TRADE, not a pure win: a cheaper model's output is still gated by
 * verify-then-accept, yet on the TS static-only lane (no karma) a weaker model
 * can emit a type-correct-but-shallow test the static gate cannot catch — so the
 * render WARNS on a TypeScript project and the choice is never a silent
 * default-down. Returns `{}` (keep the default) on non-TTY, EOF, a `[1]` choice,
 * a blank id, or exhausted retries.
 */
export async function promptModelChoice(
  io: MenuIo = defaultIo(),
  opts: { readonly isTypeScript: boolean } = { isTypeScript: false },
): Promise<ModelChoice> {
  if (!io.isTty) {
    // Non-interactive stdin: keep the default model, silently (no `--model`).
    // Mirrors promptCallLimitChoice — CI/automation never picks a model here.
    return {};
  }

  renderModelMenu(io.stdout, opts.isTypeScript);

  const reader = makeLineReader(io.stdin);
  try {
    for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt += 1) {
      io.stdout.write('Choose [1-2]: ');
      const line = await reader.next();
      if (line === null) return {};
      const choice = line.trim();
      switch (choice) {
        case '1':
          return {};
        case '2':
          return await promptModelName(io, reader);
        default:
          io.stderr.write(`Invalid choice "${choice}". Enter 1 or 2.\n`);
      }
    }
    io.stderr.write(
      `Too many invalid responses (${MAX_PROMPT_RETRIES}); keeping the default model.\n`,
    );
    return {};
  } finally {
    reader.close();
  }
}

function renderModelMenu(stdout: NodeJS.WritableStream, isTypeScript: boolean): void {
  const lines = [
    'This run will make several LLM calls. Choosing a cheaper model for this run',
    'is the single largest cost lever; your Claude Code default is the',
    'highest-quality option. Every generated test/fix is still verified before',
    'it is accepted, whatever the model.',
  ];
  if (isTypeScript) {
    // Load-bearing warning (diagnosis §1 / R5): TS validate+generate is
    // STATIC-ONLY (no karma execution — the never-build firewall), so a cheaper
    // model can emit a type-correct-but-shallow test the static gate cannot
    // catch. Never a silent default-down.
    lines.push(
      '',
      'WARNING: this is a TypeScript project, where tests are verified',
      'STATICALLY only (no test execution). A cheaper model may produce a',
      'shallow-but-compiling test the static checks cannot catch — downgrade',
      'with care.',
    );
  }
  lines.push(
    '',
    'Options:',
    '  [1] Keep your Claude Code model (recommended — max quality).',
    '  [2] Use a cheaper model for this run (you will enter its id).',
    '',
  );
  stdout.write(`${lines.join('\n')}\n`);
}

async function promptModelName(io: MenuIo, reader: LineReader): Promise<ModelChoice> {
  io.stdout.write('Enter the model id to use for this run (blank = keep the default): ');
  const line = await reader.next();
  if (line === null) return {};
  const name = line.trim();
  return name.length > 0 ? { model: name } : {};
}

function renderMainMenu(
  stdout: NodeJS.WritableStream,
  currentLimit: number,
  recommended: number,
  estimate: EstimateBounds,
  header: { readonly totalFiles: number; readonly checkCategories: number },
  headerOverride?: string,
  effectiveConcurrency?: number,
): void {
  const defaultSuffix = currentLimit === DEFAULT_LLM_BUDGET ? ' (default)' : '';
  // V1.3.1-5: `headerOverride` wins when supplied; otherwise the verbatim
  // `validate` header line — pinned by budget-menu.test.ts / validate.test.ts.
  const headerLine =
    headerOverride ??
    `Detected ${header.totalFiles} files in scope across ${header.checkCategories} check categories.`;
  const lines = [
    headerLine,
    `Estimated ${estimate.minimum}-${estimate.recommended} LLM calls needed for complete analysis.`,
    // V1.9.7 (THR-1) — surface the effective parallel dispatch width, but only
    // when actually parallel (> 1); the sequential path stays byte-identical.
    ...(effectiveConcurrency !== undefined && effectiveConcurrency > 1
      ? [`Dispatching up to ${effectiveConcurrency} LLM calls at once (--concurrency ${effectiveConcurrency}; use --concurrency 1 for sequential).`]
      : []),
    '',
    `Current call limit: ${currentLimit}${defaultSuffix}`,
    `Recommended for this project: ${recommended}`,
    '',
    'Options:',
    `  [1] Continue with current limit (${currentLimit}). Analysis may stop before completion.`,
    `  [2] Increase to recommended (${recommended}).`,
    '  [3] Enter custom limit',
    '  [4] Cancel',
    '',
  ];
  stdout.write(`${lines.join('\n')}\n`);
}

async function promptCustomLimit(
  io: MenuIo,
  reader: LineReader,
  estimate: EstimateBounds,
): Promise<MenuChoice> {
  for (let attempt = 0; attempt < MAX_PROMPT_RETRIES; attempt += 1) {
    io.stdout.write(`Custom limit (1-${CUSTOM_LIMIT_MAX}): `);
    const line = await reader.next();
    if (line === null) return { action: 'cancel' };
    const raw = line.trim();
    const parsed = Number.parseInt(raw, 10);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(parsed) || parsed <= 0) {
      io.stderr.write(
        `"${raw}" is not a positive integer. Try again.\n`,
      );
      continue;
    }
    if (parsed > CUSTOM_LIMIT_MAX) {
      io.stderr.write(
        `${parsed} exceeds the hard cap of ${CUSTOM_LIMIT_MAX}. Try again.\n`,
      );
      continue;
    }
    if (parsed < estimate.minimum) {
      io.stderr.write(
        `warning: ${parsed} calls is below the estimated minimum of ` +
          `${estimate.minimum}; analysis will likely stop before completion.\n`,
      );
    }
    return { action: 'custom', newLimit: parsed };
  }
  io.stderr.write(
    `Too many invalid custom-limit responses (${MAX_PROMPT_RETRIES}); cancelling.\n`,
  );
  return { action: 'cancel' };
}

interface LineReader {
  next(): Promise<string | null>;
  close(): void;
}

function makeLineReader(input: NodeJS.ReadableStream): LineReader {
  const rl: ReadlineInterface = createInterface({ input, terminal: false });
  const queue: string[] = [];
  const pending: Array<(line: string | null) => void> = [];
  // V1.9.4 PERF-17 — if the stream already reached EOF before this reader
  // attached, no 'close' event will fire on the new interface, so a read would
  // hang forever. This happens when a SECOND sequential menu reads the same
  // finite, already-drained stdin (the opt-in model menu after the call-limit
  // menu, e.g. a scripted integration test that feeds only the call-limit
  // answer). Treat it as closed up front — reads return null (EOF) immediately
  // and the menu keeps its default. A live TTY never ends, so production
  // prompting is unaffected.
  let closed = input instanceof Readable && input.readableEnded;
  rl.on('line', (line: string) => {
    const next = pending.shift();
    if (next !== undefined) next(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (pending.length > 0) {
      const next = pending.shift();
      if (next !== undefined) next(null);
    }
  });
  return {
    async next() {
      const head = queue.shift();
      if (head !== undefined) return head;
      if (closed) return null;
      return new Promise<string | null>((resolve) => pending.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

function defaultIo(): MenuIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTty: process.stdin.isTTY === true,
  };
}
