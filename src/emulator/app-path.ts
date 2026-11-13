/**
 * App deep links, mirrored from Planeward's
 * `packages/components/src/community-app-frame-protocol.ts` (keep the two
 * identical). A notification's `href` is a path inside the app; the community
 * site stores it on the app channel's URL as `?appPath=` and loads the app
 * frame at that path on the app's own origin.
 *
 * Used by the mock API (to validate `href` and build the stored link) and by
 * the host UI (to open a notification in the Experience view).
 */

/** Query parameter on a community channel URL that opens its app at a path. */
export const APP_PATH_SEARCH_PARAM = "appPath";

export const APP_PATH_MAX_LENGTH = 512;

/**
 * The whole rule for a deep-link path. The same pattern is published as
 * `href` of `CommunityNotificationSend` in the OpenAPI spec. In order:
 *
 * - `(?![^?]*\/(?:\.|%2[Ee]){1,2}(?:[/?]|$))`: no `.` or `..` path segment,
 *   plain or written `%2e`. A URL parser removes them, so `/..//host` would
 *   load the path `//host`.
 * - `\/(?!\/)`: one leading `/`, so never `//host` or a scheme.
 * - the rest: only characters a URL parser passes through as they are
 *   (unreserved, sub-delims, `:`, `@`, `/`, `?` and `%XX`). That leaves out
 *   `\` (parsed as `/`), tabs and newlines (stripped), `#`, spaces, other
 *   control characters and non-ASCII.
 */
const SAFE_RELATIVE_PATH =
  /^(?![^?]*\/(?:\.|%2[Ee]){1,2}(?:[/?]|$))\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/;

/**
 * True when `value` is a path with an optional query (`/orders/123?tab=1`)
 * that a URL parser resolves to exactly that path on whatever origin it is
 * resolved against. It never accepts another origin (`//host`, `/\host`,
 * `https://…`, `javascript:…`), a fragment, or anything a parser would
 * rewrite before loading it.
 */
export function isSafeRelativePath(
  value: string,
  maxLength: number = APP_PATH_MAX_LENGTH
): boolean {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    SAFE_RELATIVE_PATH.test(value)
  );
}

/** Origin of an http(s) URL, or `null` for anything else. */
function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** The part of a path-and-query string before its `?`. */
function pathnameOf(pathAndQuery: string): string {
  const queryStart = pathAndQuery.indexOf("?");
  return queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
}

/**
 * The iframe URL for an app deep link: `appPath` resolved against the origin
 * of the app's `experienceUrl`, whose own path and query are dropped. Returns
 * `null` unless `appPath` passes `isSafeRelativePath` and the result is the
 * same path on the same http(s) origin, so a deep link can only ever open the
 * app the channel belongs to.
 */
export function resolveAppFrameSrc(
  experienceUrl: string,
  appPath: string | null
): string | null {
  if (appPath === null || !isSafeRelativePath(appPath)) {
    return null;
  }
  const origin = httpOrigin(experienceUrl);
  if (!origin) {
    return null;
  }
  try {
    const resolved = new URL(appPath, experienceUrl);
    return resolved.origin === origin &&
      resolved.pathname === pathnameOf(appPath)
      ? resolved.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Community-site link that opens an app channel with the app at `appPath`.
 * This is what a production notification stores.
 */
export function communityAppChannelHref(
  channelId: string,
  appPath: string
): string {
  return `/channels/${encodeURIComponent(channelId)}?${APP_PATH_SEARCH_PARAM}=${encodeURIComponent(appPath)}`;
}
