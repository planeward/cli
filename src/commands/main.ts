/** Argument dispatch for the `planeward` bin. */
import { parseDevArgs, runDev } from "./dev";
import { CliError, UsageError } from "./errors";
import { COMMAND_HELP, isCommandName, MAIN_HELP } from "./help";
import { parseInitArgs, runInit } from "./init";
import { createOutput, type Output } from "./output";
import { packageVersion } from "./package-info";
import { parseTriggerArgs, runTrigger } from "./trigger";

export async function main(
  argv: readonly string[],
  output: Output = createOutput()
): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === undefined || first === "-h" || first === "--help") {
      output.plain(MAIN_HELP);
      return first === undefined ? 2 : 0;
    }
    if (first === "-v" || first === "--version") {
      output.plain(packageVersion());
      return 0;
    }
    if (first === "help") {
      const topic = rest[0];
      output.plain(
        topic && isCommandName(topic) ? COMMAND_HELP[topic] : MAIN_HELP
      );
      return 0;
    }
    if (!isCommandName(first)) {
      throw new UsageError(`Unknown command "${first}".`);
    }

    switch (first) {
      case "dev": {
        const options = parseDevArgs(rest);
        if (!options.help) return await runDev(options, { output });
        output.plain(COMMAND_HELP.dev);
        return 0;
      }
      case "trigger": {
        const options = parseTriggerArgs(rest);
        if (!options.help) return await runTrigger(options, { output });
        output.plain(COMMAND_HELP.trigger);
        return 0;
      }
      case "init": {
        const options = parseInitArgs(rest);
        if (!options.help) return await runInit(options, { output });
        output.plain(COMMAND_HELP.init);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      output.error(error.message);
      output.info(
        `Run "planeward ${error.command ? `${error.command} ` : ""}--help" for usage.`
      );
      return error.exitCode;
    }
    if (error instanceof CliError) {
      output.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
