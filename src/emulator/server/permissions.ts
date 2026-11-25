/** Reads the app's `/.well-known/planeward-permissions` declaration. */
import {
  PLANEWARD_PERMISSIONS_PATH,
  validatePermissionsResponse,
} from "@planeward/sdk/server";

import type { PermissionsDeclaration } from "../permissions";

const FETCH_TIMEOUT_MS = 5_000;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** `{origin}/.well-known/planeward-permissions` for any URL on the app. */
export function permissionsUrl(appUrl: string): string {
  return new URL(PLANEWARD_PERMISSIONS_PATH, new URL(appUrl).origin).href;
}

/**
 * Fetches and validates the declaration with the SDK's rules. Never throws:
 * a 404 is `none`, a bad body `invalid`, anything else `error`.
 */
export async function fetchPermissionsDeclaration(
  appUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date } = {}
): Promise<PermissionsDeclaration> {
  const url = permissionsUrl(appUrl);
  const fetchedAt = (options.now?.() ?? new Date()).toISOString();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } })
      .cause;
    return {
      url,
      fetchedAt,
      status: "error",
      error:
        cause?.code === "ECONNREFUSED"
          ? `Nothing answered on ${new URL(url).origin}. Is the app running?`
          : `Couldn't fetch ${url}: ${message(error)}${cause?.message ? ` (${cause.message})` : ""}`,
    };
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return { url, fetchedAt, status: "none" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return {
      url,
      fetchedAt,
      status: "error",
      error: `${url} answered HTTP ${response.status}; expected 200, or 404 for no permissions.`,
    };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    return {
      url,
      fetchedAt,
      status: "invalid",
      errors: [`(root): not valid JSON (${message(error)}).`],
    };
  }
  const result = validatePermissionsResponse(json);
  return result.ok
    ? { url, fetchedAt, status: "ok", declaration: result.value }
    : { url, fetchedAt, status: "invalid", errors: result.errors };
}

/**
 * The emulator's copy of the declaration. A result is kept until `refresh`;
 * an `error` (app not up yet) is retried on the next read.
 */
export class PermissionsSource {
  readonly #appUrl: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => Date;
  #latest: PermissionsDeclaration | null = null;
  #inflight: Promise<PermissionsDeclaration> | null = null;

  constructor(options: {
    appUrl: string;
    fetch?: typeof fetch;
    now: () => Date;
  }) {
    this.#appUrl = options.appUrl;
    this.#fetch = options.fetch;
    this.#now = options.now;
  }

  get url(): string {
    return permissionsUrl(this.#appUrl);
  }

  async read({ refresh = false } = {}): Promise<PermissionsDeclaration> {
    if (!refresh && this.#latest && this.#latest.status !== "error") {
      return this.#latest;
    }
    this.#inflight ??= fetchPermissionsDeclaration(this.#appUrl, {
      fetch: this.#fetch,
      now: this.#now,
    }).finally(() => {
      this.#inflight = null;
    });
    this.#latest = await this.#inflight;
    return this.#latest;
  }
}
