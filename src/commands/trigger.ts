/** `planeward trigger <event>`: asks a running emulator to send one webhook. */
import {
  EMULATOR_DEFAULT_PORT,
  EMULATOR_HOST,
  EMULATOR_ROUTES,
  EMULATOR_WEBHOOK_EVENTS,
  type EmulatorWebhookEventName,
  type TriggerRequest,
  type WebhookDeliveryEntry,
  type WebhookDeliveryResponse,
} from "../emulator/contract";
import { parseCommandArgs, parsePort, rejectPositionals } from "./args";
import { formatDelivery } from "./emulator-log";
import { CliError, UsageError } from "./errors";
import { createOutput, type Output } from "./output";

export type TriggerOptions = {
  event: string | undefined;
  member: string | undefined;
  port: number;
  help: boolean;
};

export function parseTriggerArgs(argv: readonly string[]): TriggerOptions {
  const { values, positionals } = parseCommandArgs("trigger", argv, {
    member: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  });
  rejectPositionals(positionals, "trigger", 1);
  return {
    event: positionals[0],
    member: values.member,
    port: parsePort(values.port, EMULATOR_DEFAULT_PORT, "trigger"),
    help: values.help,
  };
}

export function isEmulatorEvent(
  value: string
): value is EmulatorWebhookEventName {
  return (EMULATOR_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

const eventList = () =>
  EMULATOR_WEBHOOK_EVENTS.map((event) => `  ${event}`).join("\n");

/** POSTs to the emulator's trigger route; resolves once the delivery finished. */
export async function triggerEvent(input: {
  event: EmulatorWebhookEventName;
  memberId?: string;
  port: number;
  host?: string;
}): Promise<WebhookDeliveryEntry> {
  const origin = `http://${input.host ?? EMULATOR_HOST}:${input.port}`;
  let response: Response;
  try {
    response = await fetch(`${origin}${EMULATOR_ROUTES.trigger}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: input.event,
        ...(input.memberId ? { memberId: input.memberId } : {}),
      } satisfies TriggerRequest),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED") {
      throw new CliError(
        `No emulator is running on ${origin}. Start one with "planeward dev${input.port === EMULATOR_DEFAULT_PORT ? "" : ` --port ${input.port}`}", or pass the --port it printed.`
      );
    }
    throw new CliError(
      `Couldn't reach the emulator on ${origin}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && body && typeof body === "object" && "data" in body) {
    return (body as WebhookDeliveryResponse).data;
  }
  if (body && typeof body === "object" && "error" in body) {
    throw new CliError(String((body as { error: unknown }).error));
  }
  throw new CliError(
    `Something answered on ${origin} (HTTP ${response.status}), but it isn't a planeward emulator.`
  );
}

export async function runTrigger(
  options: TriggerOptions,
  deps: { output?: Output } = {}
): Promise<number> {
  const output = deps.output ?? createOutput();
  if (!options.event) {
    throw new UsageError(
      `Name the event to send. Events:\n${eventList()}`,
      "trigger"
    );
  }
  if (!isEmulatorEvent(options.event)) {
    throw new UsageError(
      `Unknown event "${options.event}". Events:\n${eventList()}`,
      "trigger"
    );
  }

  const entry = await triggerEvent({
    event: options.event,
    memberId: options.member,
    port: options.port,
  });

  output.info(formatDelivery(entry, output) ?? `⇢ pending ${entry.event}`);
  if (entry.url) output.info(output.paint("dim", `  ${entry.url}`));
  if (entry.status === "failed" && entry.responseBody) {
    output.info(output.paint("dim", `  ${entry.responseBody.slice(0, 500)}`));
  }
  output.info(output.paint("dim", `  delivery ${entry.deliveryId}`));
  return entry.status === "succeeded" ? 0 : 1;
}
