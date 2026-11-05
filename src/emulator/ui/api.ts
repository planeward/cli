/** Typed client for the emulator's `/__emulator/*` routes (same origin as the UI). */
import type { AppTheme, AppView } from "@planeward/sdk";

import {
  EMULATOR_ROUTES,
  emulatorPath,
  type ActivityAction,
  type ActivityResponse,
  type ActivityResult,
  type ApiRequestLogEntry,
  type ApiRequestLogResponse,
  type EmulatorErrorResponse,
  type EmulatorState,
  type EmulatorStateResponse,
  type EmulatorStreamEvent,
  type EmulatorStreamEventType,
  type MintViewerToken,
  type MintViewerTokenResponse,
  type SetViewerRequest,
  type WebhookDeliveryEntry,
  type WebhookDeliveryListResponse,
  type WebhookDeliveryResponse,
} from "../contract";

export class EmulatorApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "EmulatorApiError";
    this.status = status;
  }
}

async function call<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new EmulatorApiError("The emulator is not reachable.", 0);
  }
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const message =
      json && typeof (json as EmulatorErrorResponse).error === "string"
        ? (json as EmulatorErrorResponse).error
        : `${method} ${path} failed with ${response.status}.`;
    throw new EmulatorApiError(message, response.status);
  }
  return json as T;
}

const withAfter = (path: string, after?: string) =>
  after ? `${path}?after=${encodeURIComponent(after)}` : path;

export const emulatorApi = {
  async getState(): Promise<EmulatorState> {
    return (await call<EmulatorStateResponse>("GET", EMULATOR_ROUTES.state))
      .data;
  },
  async setViewer(viewer: SetViewerRequest): Promise<EmulatorState> {
    return (
      await call<EmulatorStateResponse>("PUT", EMULATOR_ROUTES.viewer, viewer)
    ).data;
  },
  async setView(view: AppView): Promise<EmulatorState> {
    return (
      await call<EmulatorStateResponse>("PUT", EMULATOR_ROUTES.view, { view })
    ).data;
  },
  async setTheme(theme: AppTheme): Promise<EmulatorState> {
    return (
      await call<EmulatorStateResponse>("PUT", EMULATOR_ROUTES.theme, { theme })
    ).data;
  },
  async mintToken(): Promise<MintViewerToken> {
    return (
      await call<MintViewerTokenResponse>("POST", EMULATOR_ROUTES.token, {})
    ).data;
  },
  async listRequests(after?: string): Promise<ApiRequestLogEntry[]> {
    return (
      await call<ApiRequestLogResponse>(
        "GET",
        withAfter(EMULATOR_ROUTES.requests, after)
      )
    ).data;
  },
  async listDeliveries(after?: string): Promise<WebhookDeliveryEntry[]> {
    return (
      await call<WebhookDeliveryListResponse>(
        "GET",
        withAfter(EMULATOR_ROUTES.deliveries, after)
      )
    ).data;
  },
  async redeliver(deliveryId: string): Promise<WebhookDeliveryEntry> {
    return (
      await call<WebhookDeliveryResponse>(
        "POST",
        emulatorPath(EMULATOR_ROUTES.redeliver, { deliveryId })
      )
    ).data;
  },
  async runActivity(action: ActivityAction): Promise<ActivityResult> {
    return (
      await call<ActivityResponse>("POST", EMULATOR_ROUTES.activity, action)
    ).data;
  },
  async reset(): Promise<EmulatorState> {
    return (await call<EmulatorStateResponse>("POST", EMULATOR_ROUTES.reset))
      .data;
  },
};

const STREAM_EVENT_TYPES: EmulatorStreamEventType[] = [
  "request",
  "delivery",
  "state",
];

/**
 * Subscribes to `EMULATOR_ROUTES.stream`. `onOpen` runs on every (re)connect
 * so callers can backfill what they missed. Returns an unsubscribe function.
 */
export function subscribeToEmulator(handlers: {
  onEvent: (event: EmulatorStreamEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  const source = new EventSource(EMULATOR_ROUTES.stream);
  const listener = (message: MessageEvent<string>) => {
    try {
      handlers.onEvent(JSON.parse(message.data) as EmulatorStreamEvent);
    } catch {
      // Ignore malformed frames.
    }
  };
  for (const type of STREAM_EVENT_TYPES) {
    source.addEventListener(type, listener);
  }
  source.addEventListener("open", () => handlers.onOpen?.());
  source.addEventListener("error", () => handlers.onError?.());
  return () => source.close();
}
