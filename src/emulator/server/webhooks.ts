import { createHmac, randomUUID } from "node:crypto";
import {
  PLANEWARD_DELIVERY_HEADER,
  PLANEWARD_EVENT_HEADER,
  PLANEWARD_SIGNATURE_HEADER,
  type AppWebhookEnvelope,
} from "@planeward/sdk/server";

import type { AppGrantableScope } from "../../manifest";
import type {
  EmulatorWebhookEventName,
  WebhookDeliveryEntry,
} from "../contract";
import type { DomainEvent } from "./domain";
import { grantsScope } from "./scopes";
import type { EmulatorBus, EmulatorStore } from "./store";

/**
 * Scope an installation needs to receive each event (Planeward A4 map in
 * `server/apps/webhooks.ts`); `null` events always go out.
 */
export const WEBHOOK_EVENT_SCOPES: Record<
  EmulatorWebhookEventName,
  AppGrantableScope | null
> = {
  "app.installed": null,
  "app.uninstalled": null,
  "community.membership.granted": "COMMUNITY_MEMBERS_READ",
  "community.membership.suspended": "COMMUNITY_MEMBERS_READ",
  "community.membership.resumed": "COMMUNITY_MEMBERS_READ",
  "community.membership.revoked": "COMMUNITY_MEMBERS_READ",
  "community.message.created": "COMMUNITY_MESSAGES_READ",
  "community.message.deleted": "COMMUNITY_MESSAGES_READ",
  "community.reaction.added": "COMMUNITY_MESSAGES_READ",
  "community.reaction.removed": "COMMUNITY_MESSAGES_READ",
  "community.module.completed": "COURSES_READ",
  "community.course.completed": "COURSES_READ",
  "event.registered": "EVENTS_READ",
  "event.registration_cancelled": "EVENTS_READ",
  "event.attendance_classified": "EVENTS_READ",
  "form.submitted": "FORMS_SUBMIT",
  "community.badge.awarded": "COMMUNITY_MEMBERS_READ",
  "community.badge.revoked": "COMMUNITY_MEMBERS_READ",
};

export const NO_WEBHOOK_URL_REASON =
  "No webhookPath in planeward.json, so the app has no webhook URL.";

/** Production gives up after 10 s per attempt. */
const ATTEMPT_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 4000;
const MAX_ENTRIES = 500;
const REDIRECT_MESSAGE = "Redirects are not followed.";

/** `sha256=<hex>` HMAC of the raw body, like Planeward `signWebhookBody`. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export type WebhookDispatcherOptions = {
  store: EmulatorStore;
  bus: EmulatorBus;
  secret: string;
  fetch?: typeof fetch;
  /** Wait before the single retry after a network error. */
  retryDelayMs?: number;
  /** How long `app.installed` waits for the app origin to answer. */
  appWaitTimeoutMs?: number;
};

type Attempt = {
  httpStatus: number | null;
  responseBody: string | null;
  error: string | null;
  latencyMs: number;
  networkError: boolean;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Builds, gates, signs and POSTs app webhooks, and records every delivery.
 * Each event is one delivery: tried once, then once more after a network
 * error (no long retry schedule). A redelivery keeps the delivery id.
 */
export class WebhookDispatcher {
  readonly #store: EmulatorStore;
  readonly #bus: EmulatorBus;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  readonly #appWaitTimeoutMs: number;
  #entries: WebhookDeliveryEntry[] = [];
  #seq = 0;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(options: WebhookDispatcherOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    this.#appWaitTimeoutMs = options.appWaitTimeoutMs ?? 60_000;
  }

  /** Entries after the one with id `after` (all when unknown or absent), oldest first. */
  list(after?: string | null): WebhookDeliveryEntry[] {
    if (!after) return [...this.#entries];
    const index = this.#entries.findIndex((entry) => entry.id === after);
    return index === -1 ? [...this.#entries] : this.#entries.slice(index + 1);
  }

  get(entryId: string): WebhookDeliveryEntry | undefined {
    return this.#entries.find((entry) => entry.id === entryId);
  }

  /** Records one delivery per event and starts sending; returns them at once. */
  dispatch(
    events: DomainEvent[],
    options: { waitForApp?: boolean } = {}
  ): WebhookDeliveryEntry[] {
    return events.map((event) => {
      const envelope = {
        event: event.event,
        data: event.data,
        timestamp: this.#store.nowIso(),
        installationId: this.#store.app.installationId,
        workspaceId: this.#store.app.workspaceId,
      } as AppWebhookEnvelope;
      const skippedReason = this.#skipReason(event);
      const entry = this.#record({
        deliveryId: randomUUID(),
        redeliveryOf: null,
        event: event.event,
        envelope,
        skippedReason,
      });
      if (!skippedReason) this.#track(this.#send(entry, options));
      return entry;
    });
  }

  /**
   * Sends a recorded delivery again as a new entry with the same
   * `x-planeward-delivery` id and envelope. Skipped deliveries are
   * re-gated against the current manifest.
   */
  redeliver(entryId: string): WebhookDeliveryEntry | null {
    const original = this.get(entryId);
    if (!original) return null;
    const skippedReason = this.#scopeOrUrlReason(original.event);
    const entry = this.#record({
      deliveryId: original.deliveryId,
      redeliveryOf: original.id,
      event: original.event,
      envelope: original.envelope,
      skippedReason,
    });
    if (!skippedReason) this.#track(this.#send(entry, {}));
    return entry;
  }

  /** Resolves when every delivery started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  #track(promise: Promise<void>) {
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise));
  }

  #skipReason(event: DomainEvent): string | null {
    return event.filteredReason ?? this.#scopeOrUrlReason(event.event);
  }

  #scopeOrUrlReason(event: EmulatorWebhookEventName): string | null {
    const scope = WEBHOOK_EVENT_SCOPES[event];
    if (scope && !grantsScope(new Set(this.#store.app.scopes), scope)) {
      return `Installation is not granted ${scope}.`;
    }
    if (!this.#store.app.webhookUrl) return NO_WEBHOOK_URL_REASON;
    return null;
  }

  #record(input: {
    deliveryId: string;
    redeliveryOf: string | null;
    event: EmulatorWebhookEventName;
    envelope: AppWebhookEnvelope;
    skippedReason: string | null;
  }): WebhookDeliveryEntry {
    this.#seq += 1;
    const entry: WebhookDeliveryEntry = {
      id: `delivery_${this.#seq}`,
      deliveryId: input.deliveryId,
      redeliveryOf: input.redeliveryOf,
      event: input.event,
      url: this.#store.app.webhookUrl,
      status: input.skippedReason ? "skipped" : "pending",
      skippedReason: input.skippedReason,
      httpStatus: null,
      latencyMs: null,
      error: null,
      createdAt: this.#store.nowIso(),
      envelope: input.envelope,
      responseBody: null,
    };
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) {
      this.#entries = this.#entries.slice(-MAX_ENTRIES);
    }
    this.#bus.emit({ type: "delivery", entry });
    return entry;
  }

  async #send(
    entry: WebhookDeliveryEntry,
    options: { waitForApp?: boolean }
  ): Promise<void> {
    const url = entry.url!;
    if (options.waitForApp) await this.#waitForApp(url);

    const body = JSON.stringify(entry.envelope);
    let attempt = await this.#attempt(url, body, entry);
    if (attempt.networkError) {
      await sleep(this.#retryDelayMs);
      attempt = await this.#attempt(url, body, entry);
    }

    entry.status =
      attempt.httpStatus !== null &&
      attempt.httpStatus >= 200 &&
      attempt.httpStatus < 300
        ? "succeeded"
        : "failed";
    entry.httpStatus = attempt.httpStatus;
    entry.responseBody = attempt.responseBody;
    entry.error = attempt.error;
    entry.latencyMs = attempt.latencyMs;
    this.#bus.emit({ type: "delivery", entry });
  }

  async #attempt(
    url: string,
    body: string,
    entry: WebhookDeliveryEntry
  ): Promise<Attempt> {
    const start = performance.now();
    const latency = () => Math.round(performance.now() - start);
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PLANEWARD_SIGNATURE_HEADER]: signWebhookBody(this.#secret, body),
          [PLANEWARD_DELIVERY_HEADER]: entry.deliveryId,
          [PLANEWARD_EVENT_HEADER]: entry.event,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return {
          httpStatus: response.status,
          responseBody: REDIRECT_MESSAGE,
          error: REDIRECT_MESSAGE,
          latencyMs: latency(),
          networkError: false,
        };
      }
      const text = (await response.text()).slice(0, RESPONSE_BODY_LIMIT);
      return {
        httpStatus: response.status,
        responseBody: text,
        error: response.ok ? null : `App answered ${response.status}.`,
        latencyMs: latency(),
        networkError: false,
      };
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause
          : null;
      const message =
        error instanceof Error
          ? cause
            ? `${error.message}: ${cause.message}`
            : error.message
          : "Delivery failed";
      return {
        httpStatus: null,
        responseBody: null,
        error: message.slice(0, RESPONSE_BODY_LIMIT),
        latencyMs: latency(),
        networkError: true,
      };
    }
  }

  /** Polls the webhook URL's origin until anything answers (the dev server is up). */
  async #waitForApp(url: string) {
    const origin = new URL(url).origin;
    const deadline = Date.now() + this.#appWaitTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await this.#fetch(origin, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
        return;
      } catch {
        await sleep(500);
      }
    }
  }
}
