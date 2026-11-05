/** An error the CLI prints as-is (no stack) and exits with `exitCode`. */
export class CliError extends Error {
  override readonly name = "CliError";
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Bad flags or arguments; printed with a pointer to `--help`. */
export class UsageError extends CliError {
  readonly command: string | null;

  constructor(message: string, command: string | null = null) {
    super(message, 2);
    this.command = command;
  }
}
