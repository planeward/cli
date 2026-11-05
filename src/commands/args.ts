import { parseArgs, type ParseArgsConfig } from "node:util";

import { UsageError } from "./errors";

type Options = NonNullable<ParseArgsConfig["options"]>;

/** `node:util` `parseArgs` (strict, `--no-<flag>` allowed) with errors as `UsageError`. */
export function parseCommandArgs<const T extends Options>(
  command: string,
  argv: readonly string[],
  options: T
) {
  try {
    return parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code.startsWith("ERR_PARSE_ARGS")) {
      throw new UsageError((error as Error).message, command);
    }
    throw error;
  }
}

export function parsePort(
  value: string | undefined,
  fallback: number,
  command: string
): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65_535) {
    throw new UsageError(
      `--port must be a number from 0 to 65535 (got "${value}").`,
      command
    );
  }
  return port;
}

export function rejectPositionals(
  positionals: string[],
  command: string,
  max = 0
) {
  if (positionals.length > max) {
    throw new UsageError(`Unexpected argument "${positionals[max]}".`, command);
  }
}
