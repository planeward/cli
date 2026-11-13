/**
 * Inbox tab logic: which notifications to list, and how opening one changes
 * the viewer, the view and the app frame. Kept free of React so it can be
 * tested on its own.
 */
import type { AppView, AppViewerRole } from "@planeward/sdk";

import { resolveAppFrameSrc } from "../app-path";
import type {
  EmulatorApp,
  EmulatorViewer,
  FixtureNotification,
  SetViewerRequest,
} from "../contract";

/** Filter value that follows the viewer picked in the top bar (the default). */
export const INBOX_VIEWER = "@viewer";

/** Filter value that lists every member's notifications. */
export const INBOX_ALL = "@all";

/** `INBOX_VIEWER`, `INBOX_ALL` or a member id. */
export type InboxFilter = string;

/** The member a filter selects, or `null` for every member. */
export function inboxRecipient(
  filter: InboxFilter,
  viewerId: string
): string | null {
  if (filter === INBOX_ALL) {
    return null;
  }
  return filter === INBOX_VIEWER ? viewerId : filter;
}

/**
 * Notifications for `memberId` (every member when `null`), newest first. The
 * store keeps them oldest first, so rows with the same `createdAt` keep the
 * later-stored one on top.
 */
export function inboxNotifications(
  notifications: readonly FixtureNotification[],
  memberId: string | null
): FixtureNotification[] {
  return notifications
    .map((notification, index) => ({
      notification,
      index,
      time: Date.parse(notification.createdAt) || 0,
    }))
    .filter(
      ({ notification }) =>
        memberId === null || notification.memberId === memberId
    )
    .sort((a, b) => b.time - a.time || b.index - a.index)
    .map(({ notification }) => notification);
}

/** How many notifications `memberId` has. */
export function inboxCount(
  notifications: readonly FixtureNotification[],
  memberId: string
): number {
  return notifications.filter(
    (notification) => notification.memberId === memberId
  ).length;
}

/**
 * An opened notification. The frame shows `path` while the recipient is the
 * viewer in the Experience view; `nonce` is part of the frame key, so opening
 * the same notification again reloads the app.
 */
export type DeepLink = {
  notificationId: string;
  memberId: string;
  path: string;
  nonce: number;
};

export type DeepLinkEvent =
  /** A notification was clicked and the emulator now shows its recipient. */
  | { type: "open"; notification: FixtureNotification; nonce: number }
  /** Experience or Dashboard picked, or the app channel clicked. */
  | { type: "choose-view" }
  /** A viewer picked in the top bar. */
  | { type: "choose-viewer" }
  /** Member or Admin picked in the top bar: the deep link stays. */
  | { type: "choose-role" }
  /** Switching to the recipient or the Experience view failed. */
  | { type: "open-failed" }
  /** Emulator data reset. */
  | { type: "reset" };

export function nextDeepLink(
  current: DeepLink | null,
  event: DeepLinkEvent
): DeepLink | null {
  switch (event.type) {
    case "open":
      return {
        notificationId: event.notification.id,
        memberId: event.notification.memberId,
        path: event.notification.path,
        nonce: event.nonce,
      };
    case "choose-role":
      return current;
    case "choose-view":
    case "choose-viewer":
    case "open-failed":
    case "reset":
      return null;
  }
}

/**
 * What to change before opening a notification: its recipient as the viewer
 * with the member role, in the Experience view. `null` means already so.
 */
export function openNotificationSteps(
  current: { viewer: EmulatorViewer; view: AppView },
  notification: FixtureNotification
): { viewer: SetViewerRequest | null; view: "experience" | null } {
  const viewer: SetViewerRequest = {
    memberId: notification.memberId,
    role: "member",
  };
  return {
    viewer:
      current.viewer.memberId === viewer.memberId &&
      current.viewer.role === viewer.role
        ? null
        : viewer,
    view: current.view === "experience" ? null : "experience",
  };
}

/**
 * The deep link the frame uses now: only in the Experience view and only for
 * its recipient, so a viewer change from elsewhere (another tab, a reset)
 * never shows one member another member's link.
 */
export function activeDeepLink(
  deepLink: DeepLink | null,
  current: { viewer: EmulatorViewer; view: AppView }
): DeepLink | null {
  return deepLink &&
    current.view === "experience" &&
    current.viewer.memberId === deepLink.memberId
    ? deepLink
    : null;
}

/**
 * The app frame's `src`: the dashboard URL, the experience URL, or the
 * experience URL's origin at the deep link's path. A path that doesn't
 * resolve on the app's origin falls back to the experience URL.
 */
export function appFrameSrc(
  app: Pick<EmulatorApp, "experienceUrl" | "dashboardUrl">,
  view: AppView,
  deepLink: DeepLink | null
): string | null {
  if (view === "dashboard") {
    return app.dashboardUrl ?? null;
  }
  if (!deepLink) {
    return app.experienceUrl;
  }
  return (
    resolveAppFrameSrc(app.experienceUrl, deepLink.path) ?? app.experienceUrl
  );
}

/** A new key remounts the frame with a fresh token cache. */
export function appFrameKey(parts: {
  viewerId: string;
  role: AppViewerRole;
  view: AppView;
  resetCount: number;
  deepLink: DeepLink | null;
}): string {
  return [
    parts.viewerId,
    parts.role,
    parts.view,
    parts.resetCount,
    parts.deepLink ? `link-${parts.deepLink.nonce}` : "plain",
  ].join(":");
}
