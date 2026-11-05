/**
 * Host side of the Planeward Community Apps postMessage protocol, kept free of
 * React so it can be unit tested. Mirrors the production host in the
 * Planeward repo: `packages/components/src/community-app-frame-protocol.ts`
 * (message helpers, origin checks, token cache) and the orchestration in
 * `packages/components/src/community-app-frame.tsx` (`CommunityAppFrame`).
 * Keep all three in sync. Message names come from `@planeward/sdk`.
 */
import {
  APP_MESSAGE,
  type AppContext,
  type AppTheme,
  type AppToHostMessage,
  type HostToAppMessage,
} from "@planeward/sdk";

export type AppViewerToken = {
  token: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  context: AppContext;
};

const MAX_REQUEST_ID_LENGTH = 200;

/** Origin the frame accepts messages from and posts to, or `null` if `src` is not an http(s) URL. */
export function appFrameOrigin(src: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const LOCALHOST_APP_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for an `http:` or `https:` URL on `localhost`, `127.0.0.1` or `[::1]`. */
export function isLocalhostAppUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      LOCALHOST_APP_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Same `sandbox` as the production app frame. */
export const APP_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

const APP_FRAME_ALLOW = ["clipboard-write"];

/** Chrome Local Network Access permissions, delegated to localhost apps only. */
const LOCALHOST_APP_FRAME_ALLOW = ["local-network-access", "loopback-network"];

/** The iframe `allow` attribute for an app frame (same as production). */
export function appFrameAllow(src: string): string {
  return [
    ...APP_FRAME_ALLOW,
    ...(isLocalhostAppUrl(src) ? LOCALHOST_APP_FRAME_ALLOW : []),
  ].join("; ");
}

/**
 * Accepts a `message` event only when it comes from the app iframe's window
 * and the app's origin, and its payload is a well-formed app → host message.
 */
export function readAppFrameMessage(
  event: { source: unknown; origin: string; data: unknown },
  expected: { source: unknown; origin: string | null }
): AppToHostMessage | null {
  if (
    !expected.origin ||
    !expected.source ||
    event.source !== expected.source ||
    event.origin !== expected.origin
  ) {
    return null;
  }

  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;

  if (record.type === APP_MESSAGE.ready) {
    // Production accepts any version number and treats a missing one as 1.
    return { type: APP_MESSAGE.ready, version: 1 };
  }

  if (
    record.type === APP_MESSAGE.tokenRequest &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    record.requestId.length <= MAX_REQUEST_ID_LENGTH
  ) {
    return { type: APP_MESSAGE.tokenRequest, requestId: record.requestId };
  }

  return null;
}

/** The request id a message answers: `null` for `ready`. */
export function appFrameRequestId(message: AppToHostMessage): string | null {
  return message.type === APP_MESSAGE.tokenRequest ? message.requestId : null;
}

export function appTokenMessage(
  requestId: string | null,
  token: AppViewerToken,
  theme: AppTheme
): HostToAppMessage {
  return {
    type: APP_MESSAGE.token,
    requestId,
    token: token.token,
    expiresAt: token.expiresAt,
    context: { ...token.context, theme },
  };
}

export const APP_SESSION_ERROR_MESSAGE =
  "Could not load your Planeward session.";

export function appErrorMessage(
  requestId: string | null,
  message = APP_SESSION_ERROR_MESSAGE
): HostToAppMessage {
  return { type: APP_MESSAGE.error, requestId, message };
}

export function appThemeMessage(theme: AppTheme): HostToAppMessage {
  return { type: APP_MESSAGE.theme, theme };
}

// Token cache -----------------------------------------------------------------

/** A cached token is reused while it has more than this left. */
export const APP_TOKEN_REUSE_MIN_TTL_MS = 60_000;

/** At most one token fetch per this window, unless the cached token expired. */
export const APP_TOKEN_FETCH_INTERVAL_MS = 10_000;

export const APP_TOKEN_THROTTLED_MESSAGE = "Too many token requests.";

export type AppTokenCacheState = {
  cached: AppViewerToken | null;
  inFlight: boolean;
  /** When the last fetch started (ms since epoch), or `null` if none yet. */
  lastFetchAt: number | null;
};

export type AppTokenDecision =
  | { action: "cached"; token: AppViewerToken }
  | { action: "join" }
  | { action: "fetch" }
  | { action: "throttled" };

export function initialAppTokenCacheState(): AppTokenCacheState {
  return { cached: null, inFlight: false, lastFetchAt: null };
}

/**
 * Reuse a fresh cached token, share an in-flight fetch, and otherwise fetch at
 * most once per `APP_TOKEN_FETCH_INTERVAL_MS` (an expired cache may always
 * refetch). While capped, a still-valid cached token is reused; with none,
 * the request is throttled.
 */
export function decideAppTokenRequest(
  state: AppTokenCacheState,
  now: number
): AppTokenDecision {
  const { cached } = state;
  if (cached && cached.expiresAt - now > APP_TOKEN_REUSE_MIN_TTL_MS) {
    return { action: "cached", token: cached };
  }
  if (state.inFlight) {
    return { action: "join" };
  }
  const cacheExpired = cached !== null && cached.expiresAt <= now;
  const capped =
    !cacheExpired &&
    state.lastFetchAt !== null &&
    now - state.lastFetchAt < APP_TOKEN_FETCH_INTERVAL_MS;
  if (!capped) {
    return { action: "fetch" };
  }
  return cached ? { action: "cached", token: cached } : { action: "throttled" };
}

// Host ------------------------------------------------------------------------

/** The part of the iframe's `contentWindow` the host posts to. */
export type AppFrameTarget = {
  postMessage: (message: unknown, targetOrigin: string) => void;
};

export type AppFrameHostOptions = {
  /** The app URL loaded in the iframe (`experienceUrl` or `dashboardUrl`). */
  src: string;
  /** The iframe's `contentWindow` for this load, or null before it exists. */
  getTarget: () => AppFrameTarget | null;
  /**
   * Mints a viewer token. `requestId` is `null` for the unsolicited token
   * after `ready`. Reject to send the app `planeward:app:error`.
   */
  fetchToken: (requestId: string | null) => Promise<AppViewerToken>;
  /** Host theme at construction. */
  theme: AppTheme;
  /** The app sent `ready`. */
  onReady?: () => void;
  /** Minting failed: production hides the app and offers a retry. */
  onUnavailable?: (error: unknown) => void;
  /** Every message the host posts (for the emulator's protocol log). */
  onPost?: (message: HostToAppMessage, targetOrigin: string) => void;
  now?: () => number;
};

export type AppFrameHost = {
  /** `null` when `src` is not an http(s) URL; the host then never posts. */
  readonly origin: string | null;
  /** Feed every `window` `message` event here. */
  handleMessage: (event: {
    source: unknown;
    origin: string;
    data: unknown;
  }) => void;
  /** Host theme changed; posted as `planeward:app:theme` once the app is ready. */
  setTheme: (theme: AppTheme) => void;
  /** Stops answering (the iframe was reloaded or unmounted). */
  dispose: () => void;
};

/**
 * One host per iframe load (a new `src`, viewer, view or retry gets a new
 * host, as production keys its token cache by frame). Accepts messages only
 * from `getTarget()` and the app origin, and posts only to that origin.
 */
export function createAppFrameHost(options: AppFrameHostOptions): AppFrameHost {
  const origin = appFrameOrigin(options.src);
  const now = options.now ?? Date.now;
  let theme = options.theme;
  let postedTheme: AppTheme | null = null;
  let ready = false;
  let disposed = false;
  let cache = initialAppTokenCacheState();
  let pending: Promise<AppViewerToken> | null = null;

  function post(message: HostToAppMessage) {
    const target = options.getTarget();
    if (disposed || !target || !origin) {
      return;
    }
    target.postMessage(message, origin);
    options.onPost?.(message, origin);
  }

  // Reads the theme current when the fetch resolves.
  function deliverToken(requestId: string | null, token: AppViewerToken) {
    postedTheme = theme;
    post(appTokenMessage(requestId, token, theme));
  }

  async function sendToken(requestId: string | null) {
    const decision = decideAppTokenRequest(cache, now());
    if (decision.action === "cached") {
      deliverToken(requestId, decision.token);
      return;
    }
    if (decision.action === "throttled") {
      post(appErrorMessage(requestId, APP_TOKEN_THROTTLED_MESSAGE));
      return;
    }
    if (decision.action === "fetch") {
      const fetching = options.fetchToken(requestId);
      pending = fetching;
      cache = { ...cache, inFlight: true, lastFetchAt: now() };
      fetching.then(
        (token) => {
          cache = { ...cache, cached: token, inFlight: false };
          pending = null;
        },
        () => {
          cache = { ...cache, cached: null, inFlight: false };
          pending = null;
        }
      );
    }
    const current = pending;
    if (!current) {
      return;
    }

    let token: AppViewerToken;
    try {
      token = await current;
    } catch (error) {
      if (disposed) {
        return;
      }
      options.onUnavailable?.(error);
      post(appErrorMessage(requestId));
      return;
    }
    if (disposed) {
      return;
    }
    deliverToken(requestId, token);
  }

  return {
    origin,
    handleMessage(event) {
      if (disposed) {
        return;
      }
      const message = readAppFrameMessage(event, {
        source: options.getTarget(),
        origin,
      });
      if (!message) {
        return;
      }
      if (message.type === APP_MESSAGE.ready) {
        // The token carries the current theme; only later changes need a post.
        postedTheme = theme;
        ready = true;
        options.onReady?.();
      }
      void sendToken(appFrameRequestId(message));
    },
    setTheme(next) {
      theme = next;
      if (!ready || postedTheme === next) {
        return;
      }
      postedTheme = next;
      post(appThemeMessage(next));
    },
    dispose() {
      disposed = true;
    },
  };
}
