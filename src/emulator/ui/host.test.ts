import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_MESSAGE, type HostToAppMessage } from "@planeward/sdk";

import {
  APP_SESSION_ERROR_MESSAGE,
  APP_TOKEN_THROTTLED_MESSAGE,
  appFrameAllow,
  appFrameOrigin,
  createAppFrameHost,
  decideAppTokenRequest,
  readAppFrameMessage,
  type AppViewerToken,
} from "./host";

const APP_ORIGIN = "http://localhost:3005";
const SRC = `${APP_ORIGIN}/experience`;

type Posted = { message: HostToAppMessage; targetOrigin: string };

function setup(
  options: {
    fetchToken?: (requestId: string | null) => Promise<AppViewerToken>;
    now?: () => number;
  } = {}
) {
  const posted: Posted[] = [];
  const target = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message: message as HostToAppMessage, targetOrigin });
    },
  };
  const calls: (string | null)[] = [];
  let ready = 0;
  let unavailable = 0;
  const host = createAppFrameHost({
    src: SRC,
    getTarget: () => target,
    theme: "light",
    now: options.now,
    fetchToken:
      options.fetchToken ??
      (async (requestId) => {
        calls.push(requestId);
        return {
          token: `token-${calls.length}`,
          expiresAt: Date.now() + 300_000,
          context: { view: "experience", channelId: "ch_app", theme: "dark" },
        };
      }),
    onReady: () => ready++,
    onUnavailable: () => unavailable++,
  });
  const fromApp = (data: unknown, overrides: { origin?: string } = {}) =>
    host.handleMessage({
      source: target,
      origin: overrides.origin ?? APP_ORIGIN,
      data,
    });
  return {
    host,
    target,
    posted,
    calls,
    fromApp,
    counts: () => ({ ready, unavailable }),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("readAppFrameMessage", () => {
  const source = {};
  const expected = { source, origin: APP_ORIGIN };

  it("accepts ready and token-request from the iframe window and app origin", () => {
    assert.deepEqual(
      readAppFrameMessage(
        {
          source,
          origin: APP_ORIGIN,
          data: { type: APP_MESSAGE.ready, version: 1 },
        },
        expected
      ),
      { type: APP_MESSAGE.ready, version: 1 }
    );
    assert.deepEqual(
      readAppFrameMessage(
        {
          source,
          origin: APP_ORIGIN,
          data: { type: APP_MESSAGE.tokenRequest, requestId: "r1" },
        },
        expected
      ),
      { type: APP_MESSAGE.tokenRequest, requestId: "r1" }
    );
  });

  it("rejects other origins, other windows and malformed payloads", () => {
    const ready = { type: APP_MESSAGE.ready, version: 1 };
    assert.equal(
      readAppFrameMessage(
        { source, origin: "http://localhost:4600", data: ready },
        expected
      ),
      null
    );
    assert.equal(
      readAppFrameMessage(
        { source: {}, origin: APP_ORIGIN, data: ready },
        expected
      ),
      null
    );
    assert.equal(
      readAppFrameMessage(
        { source, origin: APP_ORIGIN, data: ready },
        { source, origin: null }
      ),
      null
    );
    for (const data of [
      null,
      "planeward:app:ready",
      [ready],
      { type: APP_MESSAGE.tokenRequest },
      { type: APP_MESSAGE.tokenRequest, requestId: "" },
      { type: APP_MESSAGE.tokenRequest, requestId: "x".repeat(201) },
      { type: APP_MESSAGE.token, token: "t" },
    ]) {
      assert.equal(
        readAppFrameMessage({ source, origin: APP_ORIGIN, data }, expected),
        null
      );
    }
  });
});

describe("appFrameOrigin / appFrameAllow", () => {
  it("derives the app origin from http(s) URLs only", () => {
    assert.equal(appFrameOrigin(SRC), APP_ORIGIN);
    assert.equal(appFrameOrigin("javascript:alert(1)"), null);
    assert.equal(appFrameOrigin("not a url"), null);
  });

  it("delegates loopback access to localhost apps only", () => {
    assert.equal(
      appFrameAllow(SRC),
      "clipboard-write; local-network-access; loopback-network"
    );
    assert.equal(appFrameAllow("https://app.example.com/x"), "clipboard-write");
  });
});

describe("createAppFrameHost", () => {
  it("answers ready with an unsolicited token posted to the app origin", async () => {
    const { posted, calls, fromApp, counts } = setup();
    fromApp({ type: APP_MESSAGE.ready, version: 1 });
    await flush();

    assert.deepEqual(calls, [null]);
    assert.equal(counts().ready, 1);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].targetOrigin, APP_ORIGIN);
    assert.deepEqual(posted[0].message, {
      type: APP_MESSAGE.token,
      requestId: null,
      token: "token-1",
      expiresAt: (posted[0].message as { expiresAt: number }).expiresAt,
      // The host theme wins over the minted context's theme, like production.
      context: { view: "experience", channelId: "ch_app", theme: "light" },
    });
  });

  it("echoes the requestId of a token-request", async () => {
    let now = 1_000_000;
    const { posted, fromApp } = setup({
      now: () => now,
      fetchToken: async () => ({
        token: "t",
        // Expires within the reuse window, so the next request refetches.
        expiresAt: now + 30_000,
        context: { view: "experience", channelId: "ch_app", theme: "light" },
      }),
    });
    fromApp({ type: APP_MESSAGE.ready, version: 1 });
    await flush();
    now += 20_000;
    fromApp({ type: APP_MESSAGE.tokenRequest, requestId: "req-42" });
    await flush();

    assert.equal(posted.length, 2);
    const reply = posted[1].message;
    assert.equal(reply.type, APP_MESSAGE.token);
    assert.equal((reply as { requestId: string }).requestId, "req-42");
  });

  it("sends error with the same requestId when minting fails", async () => {
    const { posted, fromApp, counts } = setup({
      fetchToken: async () => {
        throw new Error("Viewer not found");
      },
    });
    fromApp({ type: APP_MESSAGE.tokenRequest, requestId: "req-7" });
    await flush();

    assert.equal(counts().unavailable, 1);
    assert.deepEqual(posted, [
      {
        message: {
          type: APP_MESSAGE.error,
          requestId: "req-7",
          message: APP_SESSION_ERROR_MESSAGE,
        },
        targetOrigin: APP_ORIGIN,
      },
    ]);
  });

  it("ignores messages from other origins and other windows", async () => {
    const { host, posted, calls, fromApp } = setup();
    fromApp(
      { type: APP_MESSAGE.ready, version: 1 },
      { origin: "http://evil.test" }
    );
    host.handleMessage({
      source: {},
      origin: APP_ORIGIN,
      data: { type: APP_MESSAGE.ready, version: 1 },
    });
    await flush();

    assert.deepEqual(calls, []);
    assert.deepEqual(posted, []);
  });

  it("never posts to '*'", async () => {
    const { host, posted, fromApp } = setup();
    fromApp({ type: APP_MESSAGE.ready, version: 1 });
    await flush();
    host.setTheme("dark");
    fromApp({ type: APP_MESSAGE.tokenRequest, requestId: "r" });
    await flush();

    assert.ok(posted.length >= 3);
    for (const { targetOrigin } of posted) {
      assert.equal(targetOrigin, APP_ORIGIN);
      assert.notEqual(targetOrigin, "*");
    }
  });

  it("does not post anything for a non-http src", async () => {
    const posted: unknown[] = [];
    const target = { postMessage: (m: unknown) => posted.push(m) };
    const host = createAppFrameHost({
      src: "about:blank",
      getTarget: () => target,
      theme: "light",
      fetchToken: async () => {
        throw new Error("unreachable");
      },
    });
    assert.equal(host.origin, null);
    host.handleMessage({
      source: target,
      origin: "null",
      data: { type: APP_MESSAGE.ready, version: 1 },
    });
    host.setTheme("dark");
    await flush();
    assert.deepEqual(posted, []);
  });

  it("posts theme changes only after ready and only when they differ", async () => {
    const { host, posted, fromApp } = setup();
    host.setTheme("dark");
    assert.equal(posted.length, 0, "nothing before ready");

    fromApp({ type: APP_MESSAGE.ready, version: 1 });
    await flush();
    assert.equal(
      (posted[0].message as { context: { theme: string } }).context.theme,
      "dark",
      "the token carries the current theme"
    );

    host.setTheme("dark");
    assert.equal(posted.length, 1, "unchanged theme is not re-posted");

    host.setTheme("light");
    assert.deepEqual(posted[1], {
      message: { type: APP_MESSAGE.theme, theme: "light" },
      targetOrigin: APP_ORIGIN,
    });
  });

  it("reuses a fresh cached token instead of minting again", async () => {
    const { posted, calls, fromApp } = setup();
    fromApp({ type: APP_MESSAGE.ready, version: 1 });
    await flush();
    fromApp({ type: APP_MESSAGE.tokenRequest, requestId: "again" });
    await flush();

    assert.deepEqual(calls, [null]);
    assert.equal(posted.length, 2);
    assert.equal((posted[1].message as { token: string }).token, "token-1");
  });

  it("stops posting after dispose", async () => {
    const { host, posted, fromApp } = setup();
    fromApp({ type: APP_MESSAGE.ready, version: 1 });
    host.dispose();
    await flush();
    assert.deepEqual(posted, []);
  });
});

describe("decideAppTokenRequest", () => {
  const token = (expiresAt: number): AppViewerToken => ({
    token: "t",
    expiresAt,
    context: { view: "experience", channelId: null, theme: "light" },
  });

  it("throttles repeated fetches with no cached token", () => {
    assert.deepEqual(
      decideAppTokenRequest(
        { cached: null, inFlight: false, lastFetchAt: 1_000 },
        5_000
      ),
      { action: "throttled" }
    );
    assert.equal(APP_TOKEN_THROTTLED_MESSAGE, "Too many token requests.");
  });

  it("joins an in-flight fetch and refetches an expired cache", () => {
    assert.deepEqual(
      decideAppTokenRequest(
        { cached: null, inFlight: true, lastFetchAt: 0 },
        1
      ),
      { action: "join" }
    );
    assert.deepEqual(
      decideAppTokenRequest(
        { cached: token(100), inFlight: false, lastFetchAt: 99 },
        200
      ),
      { action: "fetch" }
    );
  });
});
