/** Routes the host UI calls (`EMULATOR_ROUTES`, `contract.ts`). */
import type { AppTheme, AppView, AppViewerRole } from "@planeward/sdk";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  EMULATOR_BASE_PATH,
  EMULATOR_ROUTES,
  EMULATOR_WEBHOOK_EVENTS,
  type ActivityAction,
  type ActivityResponse,
  type ApiRequestLogResponse,
  type EmulatorStateResponse,
  type EmulatorWebhookEventName,
  type MintViewerTokenResponse,
  type TriggerRequest,
  type WebhookDeliveryEntry,
  type WebhookDeliveryListResponse,
  type WebhookDeliveryResponse,
} from "../contract";
import { applyActivity } from "./activity";
import type { Domain } from "./domain";
import { ApiError } from "./errors";
import {
  buildViewerTokenClaims,
  signViewerToken,
  type EmulatorKeys,
} from "./keys";
import type { RequestLog } from "./requests";
import type { EmulatorBus, EmulatorStore } from "./store";
import { buildTriggerEvent, TriggerError } from "./trigger";
import type { WebhookDispatcher } from "./webhooks";

export type EmulatorRouteDeps = {
  store: EmulatorStore;
  domain: Domain;
  webhooks: WebhookDispatcher;
  requests: RequestLog;
  bus: EmulatorBus;
  keys: EmulatorKeys;
  /** Current emulator base URL; the token `iss`. */
  baseUrl: () => string;
  /** Also accept {@link DEV_UI_ORIGIN} (the Vite dev server). */
  allowDevUiOrigin: boolean;
};

/** Origin of `pnpm dev:ui` (Vite); allowed only with {@link DEV_UI_ENV}. */
export const DEV_UI_ORIGIN = "http://127.0.0.1:4601";
export const DEV_UI_ENV = "PLANEWARD_EMULATOR_DEV_UI";

/**
 * `Host` values that name this emulator: `127.0.0.1:<port>` or
 * `localhost:<port>`. Anything else is a DNS-rebound name.
 */
function emulatorHosts(baseUrl: string): Set<string> {
  const url = new URL(baseUrl);
  const port = url.port ? `:${url.port}` : "";
  return new Set([`127.0.0.1${port}`, `localhost${port}`]);
}
const SSE_PING_MS = 15_000;

/** Resolves with the entry once it is no longer pending. */
function settled(
  bus: EmulatorBus,
  entry: WebhookDeliveryEntry
): Promise<WebhookDeliveryEntry> {
  if (entry.status !== "pending") return Promise.resolve(entry);
  return new Promise((resolve) => {
    const unsubscribe = bus.subscribe((event) => {
      if (
        event.type === "delivery" &&
        event.entry.id === entry.id &&
        event.entry.status !== "pending"
      ) {
        unsubscribe();
        resolve(event.entry);
      }
    });
  });
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("Send a JSON body.", 400);
  }
}

const fail = (c: Context, error: unknown) =>
  error instanceof ApiError
    ? c.json(error.body as object, error.status as ContentfulStatusCode)
    : c.json(
        {
          error: error instanceof Error ? error.message : "Internal error",
        },
        500
      );

export function createEmulatorRoutes(deps: EmulatorRouteDeps): Hono {
  const { store, domain, webhooks, requests, bus, keys } = deps;
  const app = new Hono();

  // Only the emulator's own UI (and, opted in, the Vite dev UI) may call
  // these routes. Calls without an Origin (curl, `planeward trigger`) are
  // allowed when `Host` names the emulator, which refuses DNS-rebound hosts.
  app.use(`${EMULATOR_BASE_PATH}/*`, async (c, next) => {
    const hosts = emulatorHosts(deps.baseUrl());
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    const originAllowed =
      !origin ||
      [...hosts].some((name) => origin === `http://${name}`) ||
      (deps.allowDevUiOrigin && origin === DEV_UI_ORIGIN);
    if (!hosts.has(host) || !originAllowed) {
      return c.json({ error: "Forbidden." }, 403);
    }
    await next();
    return c.res;
  });

  app.onError((error, c) => fail(c, error));

  const state = (c: Context) =>
    c.json({ data: store.snapshot() } satisfies EmulatorStateResponse);

  app.get(EMULATOR_ROUTES.state, state);

  app.put(EMULATOR_ROUTES.viewer, async (c) => {
    const body = (await readJsonBody(c)) as {
      memberId?: unknown;
      role?: unknown;
    };
    const role = body.role as AppViewerRole;
    if (role !== "member" && role !== "admin") {
      throw new ApiError('role must be "member" or "admin".', 400);
    }
    if (typeof body.memberId !== "string" || !domain.member(body.memberId)) {
      throw new ApiError("Member not found.", 404);
    }
    store.viewer = { memberId: body.memberId, role };
    store.changed();
    return state(c);
  });

  app.put(EMULATOR_ROUTES.view, async (c) => {
    const { view } = (await readJsonBody(c)) as { view?: AppView };
    if (view !== "experience" && view !== "dashboard") {
      throw new ApiError('view must be "experience" or "dashboard".', 400);
    }
    if (view === "dashboard" && !store.app.dashboardUrl) {
      throw new ApiError(
        "This app has no dashboardPath in planeward.json.",
        400
      );
    }
    store.view = view;
    store.changed();
    return state(c);
  });

  app.put(EMULATOR_ROUTES.theme, async (c) => {
    const { theme } = (await readJsonBody(c)) as { theme?: AppTheme };
    if (theme !== "light" && theme !== "dark") {
      throw new ApiError('theme must be "light" or "dark".', 400);
    }
    store.theme = theme;
    store.changed();
    return state(c);
  });

  app.post(EMULATOR_ROUTES.token, async (c) => {
    const member = domain.member(store.viewer.memberId);
    if (!member) throw new ApiError("Viewer not found.", 404);
    if (member.status !== "ACTIVE") {
      throw new ApiError(
        `${member.displayName} is ${member.status.toLowerCase()} and can't open the community.`,
        409
      );
    }
    // The Dashboard is staff-only: production always mints it as admin.
    const role: AppViewerRole =
      store.view === "dashboard" ? "admin" : store.viewer.role;
    const claims = buildViewerTokenClaims({
      issuer: deps.baseUrl(),
      appId: store.app.appId,
      workspaceId: store.app.workspaceId,
      installationId: store.app.installationId,
      view: store.view,
      channelId: store.app.channelId,
      viewer: {
        id: member.id,
        role,
        name: member.displayName,
        avatar: member.avatarUrl,
      },
      nowMs: store.now().getTime(),
    });
    const { token, expiresAt } = await signViewerToken(keys, claims);
    return c.json({
      data: {
        token,
        expiresAt,
        context: {
          view: store.view,
          channelId: claims.channelId,
          theme: store.theme,
        },
      },
    } satisfies MintViewerTokenResponse);
  });

  app.get(EMULATOR_ROUTES.requests, (c) =>
    c.json({
      data: requests.list(c.req.query("after")),
    } satisfies ApiRequestLogResponse)
  );

  app.get(EMULATOR_ROUTES.deliveries, (c) =>
    c.json({
      data: webhooks.list(c.req.query("after")),
    } satisfies WebhookDeliveryListResponse)
  );

  app.post(EMULATOR_ROUTES.redeliver, (c) => {
    const entry = webhooks.redeliver(c.req.param("deliveryId") ?? "");
    if (!entry) throw new ApiError("Delivery not found.", 404);
    return c.json({ data: entry } satisfies WebhookDeliveryResponse);
  });

  app.post(EMULATOR_ROUTES.activity, async (c) => {
    const action = (await readJsonBody(c)) as ActivityAction;
    if (
      !action ||
      typeof action !== "object" ||
      typeof action.type !== "string"
    ) {
      throw new ApiError("Send an activity with a type.", 400);
    }
    const events = applyActivity(domain, action);
    const entries = webhooks.dispatch(events);
    return c.json({
      data: {
        events: events.map((event) => event.event),
        deliveryIds: entries.map((entry) => entry.id),
        state: store.snapshot(),
      },
    } satisfies ActivityResponse);
  });

  app.post(EMULATOR_ROUTES.trigger, async (c) => {
    const body = (await readJsonBody(c)) as Partial<
      Record<keyof TriggerRequest, unknown>
    > | null;
    const event = body?.event;
    if (
      typeof event !== "string" ||
      !(EMULATOR_WEBHOOK_EVENTS as readonly string[]).includes(event)
    ) {
      throw new ApiError(
        `Unknown event. Use one of: ${EMULATOR_WEBHOOK_EVENTS.join(", ")}.`,
        400
      );
    }
    const memberId = body?.memberId;
    if (memberId !== undefined && typeof memberId !== "string") {
      throw new ApiError("memberId must be a string.", 400);
    }
    let built;
    try {
      built = buildTriggerEvent(domain, event as EmulatorWebhookEventName, {
        memberId,
      });
    } catch (error) {
      if (error instanceof TriggerError) throw new ApiError(error.message, 400);
      throw error;
    }
    const [entry] = webhooks.dispatch([built]);
    return c.json({
      data: await settled(bus, entry!),
    } satisfies WebhookDeliveryResponse);
  });

  app.post(EMULATOR_ROUTES.reset, (c) => {
    store.reset();
    return state(c);
  });

  app.get(EMULATOR_ROUTES.stream, (c) =>
    streamSSE(c, async (stream) => {
      const queue: Array<{ event: string; data: string }> = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe((event) => {
        queue.push({ event: event.type, data: JSON.stringify(event) });
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
        wake?.();
      });
      queue.push({
        event: "state",
        data: JSON.stringify({ type: "state", state: store.snapshot() }),
      });
      while (open) {
        while (queue.length > 0 && open) {
          await stream.writeSSE(queue.shift()!);
        }
        if (!open) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SSE_PING_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
        if (open && queue.length === 0) await stream.write(": ping\n\n");
      }
      unsubscribe();
    })
  );

  app.all(`${EMULATOR_BASE_PATH}/*`, (c) =>
    c.json({ error: "Not found." }, 404)
  );

  return app;
}
