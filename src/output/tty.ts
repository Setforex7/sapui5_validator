export interface OutputCapabilities {
  isTTY: boolean;
  useColor: boolean;
  useSpinner: boolean;
}

export interface TtyEnvironment {
  stream?: { isTTY?: boolean | undefined };
  env?: NodeJS.ProcessEnv;
}

export function detectCapabilities(input: TtyEnvironment = {}): OutputCapabilities {
  const stream = input.stream ?? process.stdout;
  const env = input.env ?? process.env;
  const isTTY = stream.isTTY === true;
  const noColor = typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '';
  const forceColor = typeof env.FORCE_COLOR === 'string' && env.FORCE_COLOR !== '0';
  return {
    isTTY,
    useColor: forceColor || (isTTY && !noColor),
    useSpinner: isTTY && !noColor,
  };
}
