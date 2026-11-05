/**
 * Follows the emulator's SSE stream (`EMULATOR_ROUTES.stream`) and prints one
 * line per API request (`→`) and finished webhook delivery (`⇢`).
 */
import {
  EMULATOR_ROUTES,
  type ApiRequestLogEntry,
  type EmulatorStreamEvent,
  type WebhookDeliveryEntry,
} from "../emulator/contract";
import { createLineSplitter, type Output } from "./output";

function statusStyle(status: number) {
  if (status >= 500) return "red" as const;
  if (status >= 400) return "yellow" as const;
  return "green" as const;
}

export function formatRequest(
  entry: ApiRequestLogEntry,
  output: Output
): string {
  const query = entry.query ? `?${entry.query}` : "";
  const line = `→ ${entry.status} ${entry.method} ${entry.path}${query} ${entry.durationMs}ms`;
  if (entry.missingScope) {
    return output.paint(
      "red",
      `${line}  missing ${entry.missingScope}: add ${entry.missingScope} to planeward.json scopes and restart planeward dev`
    );
  }
  return output.paint(statusStyle(entry.status), line);
}

/** Null while the delivery is still pending (it's printed once it finishes). */
export function formatDelivery(
  entry: WebhookDeliveryEntry,
  output: Output
): string | null {
  const redelivery = entry.redeliveryOf ? " (redelivery)" : "";
  switch (entry.status) {
    case "pending":
      return null;
    case "skipped":
      return output.paint(
        "dim",
        `⇢ skipped ${entry.event}${redelivery}: ${entry.skippedReason ?? "not sent"}`
      );
    case "succeeded":
      return output.paint(
        "green",
        `⇢ ${entry.httpStatus} ${entry.event}${redelivery} ${entry.latencyMs}ms`
      );
    case "failed": {
      const status = entry.httpStatus ?? "ERR";
      const reason = entry.error ? `: ${entry.error}` : "";
      return output.paint(
        "red",
        `⇢ ${status} ${entry.event}${redelivery} ${entry.latencyMs ?? 0}ms${reason}`
      );
    }
  }
}

/**
 * Subscribes to the stream and prints request and delivery lines until
 * `signal` aborts. Resolves once connected.
 */
export async function followEmulatorLog(options: {
  url: string;
  output: Output;
  signal: AbortSignal;
}): Promise<void> {
  const { output, signal } = options;
  const response = await fetch(`${options.url}${EMULATOR_ROUTES.stream}`, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    output.warn(`Couldn't follow the emulator log (HTTP ${response.status}).`);
    return;
  }

  let data = "";
  const splitter = createLineSplitter((line) => {
    if (line.startsWith("data:")) {
      data += line.slice(5).trimStart();
      return;
    }
    if (line !== "" || !data) return;
    let event: EmulatorStreamEvent;
    try {
      event = JSON.parse(data) as EmulatorStreamEvent;
    } catch {
      data = "";
      return;
    }
    data = "";
    if (event.type === "request")
      output.info(formatRequest(event.entry, output));
    if (event.type === "delivery") {
      const line = formatDelivery(event.entry, output);
      if (line) output.info(line);
    }
  });

  const body = response.body.pipeThrough(new TextDecoderStream());
  void (async () => {
    try {
      for await (const chunk of body) splitter.push(chunk);
    } catch {
      // Aborted on shutdown, or the emulator closed the stream.
    }
  })();
}
