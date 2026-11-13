import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EmulatorViewer, FixtureNotification } from "../contract";
import {
  activeDeepLink,
  appFrameKey,
  appFrameSrc,
  INBOX_ALL,
  INBOX_VIEWER,
  inboxCount,
  inboxNotifications,
  inboxRecipient,
  nextDeepLink,
  openNotificationSteps,
  type DeepLink,
} from "./inbox";

const APP = {
  experienceUrl: "http://localhost:3005/experience?embed=1",
  dashboardUrl: "http://localhost:3005/dashboard",
};

function notification(
  id: string,
  memberId: string,
  createdAt: string,
  path = "/orders/123?tab=items"
): FixtureNotification {
  return {
    id,
    memberId,
    title: "Orders",
    body: "Your order shipped.",
    path,
    href: `/channels/channel_app?appPath=${encodeURIComponent(path)}`,
    createdAt,
  };
}

// Stored oldest first, like `entities.notifications`.
const STORED = [
  notification("n1", "member_1", "2026-01-01T10:00:00.000Z"),
  notification("n2", "member_2", "2026-01-01T10:01:00.000Z"),
  notification("n3", "member_1", "2026-01-01T10:02:00.000Z"),
  notification("n4", "member_1", "2026-01-01T10:02:00.000Z"),
];

const member = (memberId: string): EmulatorViewer => ({
  memberId,
  role: "member",
});

describe("inbox filter", () => {
  it("follows the viewer by default, lists everyone for all, or one member", () => {
    assert.equal(inboxRecipient(INBOX_VIEWER, "member_1"), "member_1");
    assert.equal(inboxRecipient(INBOX_ALL, "member_1"), null);
    assert.equal(inboxRecipient("member_2", "member_1"), "member_2");
  });

  it("lists the member's notifications newest first, later-stored first on a tie", () => {
    assert.deepEqual(
      inboxNotifications(STORED, "member_1").map((entry) => entry.id),
      ["n4", "n3", "n1"]
    );
    assert.deepEqual(
      inboxNotifications(STORED, null).map((entry) => entry.id),
      ["n4", "n3", "n2", "n1"]
    );
    assert.deepEqual(inboxNotifications(STORED, "member_9"), []);
  });

  it("sorts by time, not by stored order", () => {
    const outOfOrder = [
      notification("late", "member_1", "2026-01-02T00:00:00.000Z"),
      notification("early", "member_1", "2026-01-01T00:00:00.000Z"),
    ];
    assert.deepEqual(
      inboxNotifications(outOfOrder, null).map((entry) => entry.id),
      ["late", "early"]
    );
  });

  it("doesn't change the stored list", () => {
    const copy = [...STORED];
    inboxNotifications(STORED, null);
    assert.deepEqual(STORED, copy);
  });

  it("counts a member's notifications", () => {
    assert.equal(inboxCount(STORED, "member_1"), 3);
    assert.equal(inboxCount(STORED, "member_2"), 1);
    assert.equal(inboxCount(STORED, "member_9"), 0);
  });
});

describe("opening a notification", () => {
  const n3 = STORED[2]!;

  it("switches to the recipient as a member in the Experience view", () => {
    assert.deepEqual(
      openNotificationSteps(
        { viewer: { memberId: "member_2", role: "admin" }, view: "dashboard" },
        n3
      ),
      { viewer: { memberId: "member_1", role: "member" }, view: "experience" }
    );
    assert.deepEqual(
      openNotificationSteps(
        { viewer: { memberId: "member_1", role: "admin" }, view: "experience" },
        n3
      ),
      { viewer: { memberId: "member_1", role: "member" }, view: null }
    );
    assert.deepEqual(
      openNotificationSteps(
        { viewer: member("member_1"), view: "dashboard" },
        n3
      ),
      { viewer: null, view: "experience" }
    );
    assert.deepEqual(
      openNotificationSteps(
        { viewer: member("member_1"), view: "experience" },
        n3
      ),
      { viewer: null, view: null }
    );
  });

  it("opens with a new nonce each time, so the same notification reloads", () => {
    const first = nextDeepLink(null, {
      type: "open",
      notification: n3,
      nonce: 1,
    });
    assert.deepEqual(first, {
      notificationId: "n3",
      memberId: "member_1",
      path: "/orders/123?tab=items",
      nonce: 1,
    });
    const again = nextDeepLink(first, {
      type: "open",
      notification: n3,
      nonce: 2,
    });
    const key = (deepLink: DeepLink | null) =>
      appFrameKey({
        viewerId: "member_1",
        role: "member",
        view: "experience",
        resetCount: 0,
        deepLink,
      });
    assert.notEqual(key(first), key(again));
    assert.notEqual(key(first), key(null));
  });

  it("is cleared by choosing a view or a viewer, a reset or a failed open, not by a role", () => {
    const open = nextDeepLink(null, {
      type: "open",
      notification: n3,
      nonce: 1,
    });
    assert.equal(nextDeepLink(open, { type: "choose-view" }), null);
    assert.equal(nextDeepLink(open, { type: "choose-viewer" }), null);
    assert.equal(nextDeepLink(open, { type: "reset" }), null);
    assert.equal(nextDeepLink(open, { type: "open-failed" }), null);
    assert.equal(nextDeepLink(open, { type: "choose-role" }), open);
  });

  it("applies only to the recipient in the Experience view", () => {
    const open = nextDeepLink(null, {
      type: "open",
      notification: n3,
      nonce: 1,
    });
    assert.equal(
      activeDeepLink(open, { viewer: member("member_1"), view: "experience" }),
      open
    );
    assert.equal(
      activeDeepLink(open, {
        viewer: { memberId: "member_1", role: "admin" },
        view: "experience",
      }),
      open
    );
    assert.equal(
      activeDeepLink(open, { viewer: member("member_2"), view: "experience" }),
      null
    );
    assert.equal(
      activeDeepLink(open, { viewer: member("member_1"), view: "dashboard" }),
      null
    );
    assert.equal(
      activeDeepLink(null, { viewer: member("member_1"), view: "experience" }),
      null
    );
  });
});

describe("appFrameSrc", () => {
  const link = (path: string): DeepLink => ({
    notificationId: "n1",
    memberId: "member_1",
    path,
    nonce: 1,
  });

  it("loads the experience or dashboard URL without a deep link", () => {
    assert.equal(appFrameSrc(APP, "experience", null), APP.experienceUrl);
    assert.equal(appFrameSrc(APP, "dashboard", null), APP.dashboardUrl);
    assert.equal(
      appFrameSrc({ ...APP, dashboardUrl: null }, "dashboard", null),
      null
    );
  });

  it("loads the deep link's path on the app's origin, dropping the experience path and query", () => {
    const src = appFrameSrc(APP, "experience", link("/orders/123?tab=items"));
    assert.equal(src, "http://localhost:3005/orders/123?tab=items");
    assert.equal(new URL(src!).origin, new URL(APP.experienceUrl).origin);
  });

  it("ignores a deep link in the dashboard", () => {
    assert.equal(
      appFrameSrc(APP, "dashboard", link("/orders/1")),
      APP.dashboardUrl
    );
  });

  it("falls back to the experience URL for a path that would leave the app", () => {
    for (const path of [
      "//evil.example/x",
      "https://evil.example/",
      "/\\evil.example",
      "/a/../b",
      "javascript:alert(1)",
      "/a#b",
    ]) {
      assert.equal(
        appFrameSrc(APP, "experience", link(path)),
        APP.experienceUrl,
        path
      );
    }
  });
});
