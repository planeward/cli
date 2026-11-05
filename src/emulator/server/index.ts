/**
 * The local Planeward emulator: viewer tokens + JWKS, the mock v1 API, signed
 * webhooks and the host UI, on 127.0.0.1 only.
 *
 * `startEmulator` is what `planeward dev` runs; `createEmulatorApp` builds the
 * same Hono app without listening (tests).
 */
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { APP_JWKS_PATH } from "@planeward/sdk/server";
import { Hono } from "hono";

import type { PlanewardManifest } from "../../manifest";
import {
  EMULATOR_DEFAULT_ORIGIN,
  EMULATOR_DEFAULT_PORT,
  EMULATOR_HOST,
  EMULATOR_INSTALLATION_ID,
  EMULATOR_WORKSPACE_ID,
  type EmulatorApp,
  type EmulatorWebhookEventName,
  type WebhookDeliveryEntry,
} from "../contract";
import { API_PREFIX, createApiRoutes } from "./api";
import { Domain } from "./domain";
import { createEmulatorRoutes, DEV_UI_ENV } from "./emulator-routes";
import { APP_CHANNEL_ID } from "./fixtures";
import { loadOrCreateKeys, type EmulatorKeys } from "./keys";
import { RequestLog } from "./requests";
import { orderedScopes } from "./scopes";
import { ensureStateDir } from "./state-dir";
import { createStaticHandler, defaultUiDir } from "./static";
import { EmulatorBus, EmulatorStore } from "./store";
import {
  appInstalledEvent,
  buildTriggerEvent,
  type TriggerOptions,
} from "./trigger";
import { WebhookDispatcher } from "./webhooks";

export { TriggerError, type TriggerOptions } from "./trigger";
export { signWebhookBody } from "./webhooks";

export type CreateEmulatorAppOptions = {
  manifest: PlanewardManifest;
  /** Where the app runs; defaults to `manifest.dev.url`. */
  appOrigin?: string;
  /** `<appDir>/.planeward`; null keeps keys and state in memory (tests). */
  stateDir: string | null;
  /** Reseed instead of loading `state.json`. */
  reset?: boolean;
  /** Token `iss`; `startEmulator` sets it to the URL it listens on. */
  baseUrl?: string;
  /** Prebuilt host UI; defaults to the package's `dist/ui`. */
  uiDir?: string;
  now?: () => Date;
  /** Used for webhook deliveries. */
  fetch?: typeof fetch;
  /** Wait before the single webhook retry after a network error (default 1000). */
  webhookRetryDelayMs?: number;
  /**
   * Let the Vite dev UI (`pnpm dev:ui`, `http://127.0.0.1:4601`) call the
   * emulator routes. Defaults to `PLANEWARD_EMULATOR_DEV_UI=1`.
   */
  allowDevUiOrigin?: boolean;
};

export type EmulatorInstance = {
  app: Hono;
  store: EmulatorStore;
  domain: Domain;
  webhooks: WebhookDispatcher;
  requests: RequestLog;
  keys: EmulatorKeys;
  /** True when the state was seeded (no `state.json`, or `reset`). */
  fresh: boolean;
  setBaseUrl: (url: string) => void;
  /** Sends one webhook event built from the current state. */
  trigger: (
    event: EmulatorWebhookEventName,
    options?: TriggerOptions
  ) => WebhookDeliveryEntry;
};

const trimSlash = (value: string) => value.replace(/\/+$/, "");

function joinUrl(origin: string, path: string) {
  return `${trimSlash(origin)}/${path.replace(/^\/+/, "")}`;
}

/** `EmulatorApp` from the manifest: `<slug>-local`, fixed local ids, URLs on `dev.url`. */
export function emulatorAppFromManifest(
  manifest: PlanewardManifest,
  appOrigin: string = manifest.dev.url
): EmulatorApp {
  return {
    name: manifest.name,
    slug: manifest.slug,
    appId: `${manifest.slug}-local`,
    installationId: EMULATOR_INSTALLATION_ID,
    workspaceId: EMULATOR_WORKSPACE_ID,
    channelId: APP_CHANNEL_ID,
    scopes: orderedScopes(manifest.scopes),
    experienceUrl: joinUrl(appOrigin, manifest.experiencePath),
    dashboardUrl: manifest.dashboardPath
      ? joinUrl(appOrigin, manifest.dashboardPath)
      : null,
    webhookUrl: manifest.webhookPath
      ? joinUrl(appOrigin, manifest.webhookPath)
      : null,
    dev: { command: manifest.dev.command, url: manifest.dev.url },
  };
}

export async function createEmulatorApp(
  options: CreateEmulatorAppOptions
): Promise<EmulatorInstance> {
  const appOrigin = options.appOrigin ?? options.manifest.dev.url;
  const appInfo = emulatorAppFromManifest(options.manifest, appOrigin);
  const bus = new EmulatorBus();
  if (options.stateDir) await ensureStateDir(options.stateDir);
  const keys = await loadOrCreateKeys(options.stateDir);
  const { store, fresh } = await EmulatorStore.open({
    app: appInfo,
    stateDir: options.stateDir,
    bus,
    now: options.now ?? (() => new Date()),
    reset: options.reset ?? false,
  });
  const domain = new Domain(store);
  const requests = new RequestLog(bus);
  const webhooks = new WebhookDispatcher({
    store,
    bus,
    secret: keys.webhookSecret,
    fetch: options.fetch,
    retryDelayMs: options.webhookRetryDelayMs,
  });

  let baseUrl = trimSlash(options.baseUrl ?? EMULATOR_DEFAULT_ORIGIN);
  let appOriginValue: string | null = null;
  try {
    appOriginValue = new URL(appOrigin).origin;
  } catch {
    appOriginValue = null;
  }

  const app = new Hono();
  app.get(APP_JWKS_PATH, (c) =>
    c.json(keys.jwks, 200, { "Cache-Control": "no-store" })
  );
  app.route(
    API_PREFIX,
    createApiRoutes({
      store,
      domain,
      webhooks,
      requests,
      appSecret: keys.appSecret,
      appOrigin: appOriginValue,
    })
  );
  app.route(
    "/",
    createEmulatorRoutes({
      store,
      domain,
      webhooks,
      requests,
      bus,
      keys,
      baseUrl: () => baseUrl,
      allowDevUiOrigin:
        options.allowDevUiOrigin ?? process.env[DEV_UI_ENV] === "1",
    })
  );
  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
  app.all("*", createStaticHandler(options.uiDir ?? defaultUiDir()));

  return {
    app,
    store,
    domain,
    webhooks,
    requests,
    keys,
    fresh,
    setBaseUrl: (url) => {
      baseUrl = trimSlash(url);
    },
    trigger: (event, triggerOptions) =>
      webhooks.dispatch([buildTriggerEvent(domain, event, triggerOptions)])[0]!,
  };
}

export type StartEmulatorOptions = Omit<CreateEmulatorAppOptions, "baseUrl"> & {
  /** Default 4600; 0 picks a free port. Always bound to 127.0.0.1. */
  port?: number;
};

export type RunningEmulator = {
  /** `http://127.0.0.1:<port>`: `PLANEWARD_BASE_URL` and the token `iss`. */
  url: string;
  port: number;
  /** `<slug>-local`: `PLANEWARD_APP_ID`. */
  appId: string;
  installationId: string;
  /** `pwa_local_…`: `PLANEWARD_APP_SECRET`. */
  appSecret: string;
  /** `PLANEWARD_WEBHOOK_SECRET`. */
  webhookSecret: string;
  /** The four `PLANEWARD_*` variables to inject into the app's dev process. */
  env: Record<
    | "PLANEWARD_BASE_URL"
    | "PLANEWARD_APP_ID"
    | "PLANEWARD_APP_SECRET"
    | "PLANEWARD_WEBHOOK_SECRET",
    string
  >;
  /** True when this start seeded fresh state (and queued `app.installed`). */
  fresh: boolean;
  /**
   * Sends one webhook event built from the current state, waits for the
   * delivery to finish, and returns it. Throws `TriggerError` when the event
   * can't be built (for example no badges yet).
   */
  trigger: (
    event: EmulatorWebhookEventName,
    options?: TriggerOptions
  ) => Promise<WebhookDeliveryEntry>;
  /** Waits for in-flight webhook deliveries. */
  idle: () => Promise<void>;
  /** Stops the server and writes pending state. */
  close: () => Promise<void>;
  instance: EmulatorInstance;
};

function listen(
  app: Hono,
  port: number
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, hostname: EMULATOR_HOST },
      (info: AddressInfo) => resolve({ server, port: info.port })
    );
    server.once("error", reject);
  });
}

/**
 * Starts the emulator on `127.0.0.1:<port>`. On a fresh state it queues
 * `app.installed`, which waits for the app origin to answer before sending.
 */
export async function startEmulator(
  options: StartEmulatorOptions
): Promise<RunningEmulator> {
  const instance = await createEmulatorApp(options);
  const { server, port } = await listen(
    instance.app,
    options.port ?? EMULATOR_DEFAULT_PORT
  );
  const url = `http://${EMULATOR_HOST}:${port}`;
  instance.setBaseUrl(url);

  if (instance.fresh) {
    instance.webhooks.dispatch([appInstalledEvent(instance.store)], {
      waitForApp: true,
    });
  }

  const { store, keys, webhooks } = instance;
  let closed = false;

  return {
    url,
    port,
    appId: store.app.appId,
    installationId: store.app.installationId,
    appSecret: keys.appSecret,
    webhookSecret: keys.webhookSecret,
    env: {
      PLANEWARD_BASE_URL: url,
      PLANEWARD_APP_ID: store.app.appId,
      PLANEWARD_APP_SECRET: keys.appSecret,
      PLANEWARD_WEBHOOK_SECRET: keys.webhookSecret,
    },
    fresh: instance.fresh,
    instance,
    async trigger(event, triggerOptions) {
      const entry = instance.trigger(event, triggerOptions);
      await webhooks.idle();
      return entry;
    },
    idle: () => webhooks.idle(),
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // SSE streams keep connections open; drop them.
        (
          server as { closeAllConnections?: () => void }
        ).closeAllConnections?.();
      });
      await store.flush();
    },
  };
}
