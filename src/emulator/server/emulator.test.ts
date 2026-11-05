import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createPlanewardClient,
  parsePlanewardWebhook,
  PLANEWARD_DELIVERY_HEADER,
  PLANEWARD_EVENT_HEADER,
  PLANEWARD_SIGNATURE_HEADER,
  PlanewardApiError,
  verifyPlanewardToken,
  verifyPlanewardWebhook,
  type AppWebhookEnvelope,
  type PlanewardClient,
} from "@planeward/sdk/server";

import { APP_GRANTABLE_SCOPES, type PlanewardManifest } from "../../manifest";
import {
  EMULATOR_INSTALLATION_ID,
  EMULATOR_ROUTES,
  emulatorPath,
  type ActivityAction,
  type ActivityResponse,
  type ApiRequestLogResponse,
  type MintViewerTokenResponse,
  type WebhookDeliveryEntry,
  type WebhookDeliveryListResponse,
  type WebhookDeliveryResponse,
} from "../contract";
import { HIDDEN_CHANNEL_REASON, UNFLAGGED_EVENT_REASON } from "./domain";
import { startEmulator, TriggerError, type RunningEmulator } from "./index";
import {
  loadOpenApiValidator,
  type OpenApiValidator,
} from "./openapi-test-support";
import { STATE_FILE_NAME } from "./store";

type Received = {
  headers: Record<string, string | undefined>;
  rawBody: string;
  envelope: AppWebhookEnvelope;
};

/** A stand-in app: records signed webhook POSTs. */
async function startReceiver() {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (rawBody += chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        received.push({
          headers: {
            signature: req.headers[PLANEWARD_SIGNATURE_HEADER] as string,
            delivery: req.headers[PLANEWARD_DELIVERY_HEADER] as string,
            event: req.headers[PLANEWARD_EVENT_HEADER] as string,
          },
          rawBody,
          envelope: parsePlanewardWebhook(rawBody),
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function manifestFor(
  devUrl: string,
  overrides: Partial<PlanewardManifest> = {}
): PlanewardManifest {
  return {
    name: "Leaderboard",
    slug: "leaderboard",
    experiencePath: "/experience",
    dashboardPath: "/dashboard",
    webhookPath: "/api/webhooks/planeward",
    scopes: [...APP_GRANTABLE_SCOPES],
    dev: { command: "next dev --port 3005", url: devUrl },
    ...overrides,
  };
}

type Call = { status: number; body: any };

function apiCaller(emulator: RunningEmulator) {
  return async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<Call> => {
    const response = await fetch(`${emulator.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${emulator.appSecret}`,
        "x-planeward-installation": emulator.installationId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

function emulatorCaller(emulator: RunningEmulator) {
  return async <T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${emulator.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
}

async function waitFor<T>(
  read: () => T | undefined | null | false,
  label: string,
  timeoutMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("emulator", () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let emulator: RunningEmulator;
  let stateDir: string;
  let client: PlanewardClient;
  let spec: OpenApiValidator;
  let api: ReturnType<typeof apiCaller>;
  let local: ReturnType<typeof emulatorCaller>;

  const activity = (action: ActivityAction) =>
    local<ActivityResponse>("POST", EMULATOR_ROUTES.activity, action);

  before(async () => {
    spec = loadOpenApiValidator();
    receiver = await startReceiver();
    stateDir = await mkdtemp(join(tmpdir(), "planeward-emulator-"));
    emulator = await startEmulator({
      manifest: manifestFor(receiver.url),
      stateDir,
      port: 0,
      webhookRetryDelayMs: 10,
    });
    client = createPlanewardClient({
      secret: emulator.appSecret,
      installationId: emulator.installationId,
      baseUrl: emulator.url,
    });
    api = apiCaller(emulator);
    local = emulatorCaller(emulator);
  });

  after(async () => {
    await emulator?.close();
    await receiver?.close();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });

  it("listens on 127.0.0.1 and exposes the env the app needs", () => {
    assert.match(emulator.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(emulator.appId, "leaderboard-local");
    assert.equal(emulator.installationId, EMULATOR_INSTALLATION_ID);
    assert.match(emulator.appSecret, /^pwa_local_/);
    assert.deepEqual(emulator.env, {
      PLANEWARD_BASE_URL: emulator.url,
      PLANEWARD_APP_ID: "leaderboard-local",
      PLANEWARD_APP_SECRET: emulator.appSecret,
      PLANEWARD_WEBHOOK_SECRET: emulator.webhookSecret,
    });
    assert.equal(emulator.fresh, true);
  });

  it("mints viewer tokens that the SDK verifies against the JWKS", async () => {
    const { status, body } = await local<MintViewerTokenResponse>(
      "POST",
      EMULATOR_ROUTES.token,
      {}
    );
    assert.equal(status, 200);
    const claims = await verifyPlanewardToken(body.data.token, {
      appId: emulator.appId,
      baseUrl: emulator.url,
    });
    assert.equal(claims.iss, emulator.url);
    assert.equal(claims.aud, "leaderboard-local");
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(claims.view, "experience");
    assert.equal(claims.channelId, "channel_app");
    assert.equal(claims.role, "member");
    assert.equal(claims.installationId, EMULATOR_INSTALLATION_ID);
    assert.equal(body.data.expiresAt, claims.exp * 1000);
    assert.deepEqual(body.data.context, {
      view: "experience",
      channelId: "channel_app",
      theme: "light",
    });

    // Another app id is rejected, like production.
    await assert.rejects(
      verifyPlanewardToken(body.data.token, {
        appId: "someone-else",
        baseUrl: emulator.url,
      })
    );

    // Dashboard tokens are always admin, with no channel.
    await local("PUT", EMULATOR_ROUTES.view, { view: "dashboard" });
    const dashboard = await local<MintViewerTokenResponse>(
      "POST",
      EMULATOR_ROUTES.token,
      {}
    );
    const dashboardClaims = await verifyPlanewardToken(
      dashboard.body.data.token,
      {
        appId: emulator.appId,
        baseUrl: emulator.url,
      }
    );
    assert.equal(dashboardClaims.role, "admin");
    assert.equal(dashboardClaims.channelId, null);
    await local("PUT", EMULATOR_ROUTES.view, { view: "experience" });
  });

  it("sends app.installed on a fresh state, signed like production", async () => {
    const installed = await waitFor(
      () =>
        receiver.received.find(
          (item) => item.envelope.event === "app.installed"
        ),
      "app.installed"
    );
    assert.equal(
      await verifyPlanewardWebhook({
        rawBody: installed.rawBody,
        signature: installed.headers.signature,
        secret: emulator.webhookSecret,
      }),
      true
    );
    assert.equal(installed.headers.event, "app.installed");
    assert.ok(installed.headers.delivery);
    assert.equal(installed.envelope.installationId, EMULATOR_INSTALLATION_ID);
    assert.equal(installed.envelope.event, "app.installed");
    if (installed.envelope.event === "app.installed") {
      assert.deepEqual(installed.envelope.data.grantedPermissions, [
        ...APP_GRANTABLE_SCOPES,
      ]);
    }
  });

  it("has a spec validator that catches drift", async () => {
    const member = (await client.community.members.get("member_05")).data;
    spec.assertResponse("get", "/community/members/{memberId}", 200, {
      data: member,
    });
    assert.equal(member.username, null, "nullable fields accept null");
    assert.throws(() =>
      spec.assertResponse("get", "/community/members/{memberId}", 200, {
        data: { ...member, badges: undefined },
      })
    );
    assert.throws(() =>
      spec.assertResponse("get", "/community/members/{memberId}", 200, {
        data: { ...member, username: 42 },
      })
    );
    assert.throws(() =>
      spec.assertResponse("get", "/community/members/{memberId}", 200, {
        data: { ...member, joinedAt: "yesterday" },
      })
    );
  });

  it("answers every SDK client method with responses that match the OpenAPI spec", async () => {
    const check = (
      method: string,
      path: string,
      status: number,
      body: unknown
    ) => spec.assertResponse(method, path, status, body);

    check(
      "get",
      "/community/channels",
      200,
      await client.community.channels.list()
    );
    const channels = await client.community.channels.list();
    assert.deepEqual(
      channels.data.map((channel) => channel.id),
      [
        "channel_announcements",
        "channel_general",
        "channel_wins",
        "channel_app",
      ]
    );

    const firstPage = await client.community.messages.list("channel_general", {
      limit: 2,
    });
    check("get", "/community/channels/{channelId}/messages", 200, firstPage);
    assert.equal(firstPage.data.length, 2);
    assert.ok(firstPage.meta.nextCursor);
    const secondPage = await client.community.messages.list("channel_general", {
      limit: 2,
      cursor: firstPage.meta.nextCursor!,
    });
    assert.equal(
      new Set([...firstPage.data, ...secondPage.data].map((m) => m.id)).size,
      4
    );
    const allGeneral = await client.community.messages.list("channel_general");
    assert.ok(
      allGeneral.data.every((message) => message.id !== "msg_0006"),
      "deleted messages are left out"
    );

    const posted = await client.community.messages.create("channel_general", {
      body: "  Hello from the app  ",
    });
    check("post", "/community/channels/{channelId}/messages", 201, posted);
    assert.equal(posted.data.body, "Hello from the app");
    assert.equal(posted.data.author.kind, "app");

    const members = await client.community.members.list({ limit: 5 });
    check("get", "/community/members", 200, members);
    assert.equal(members.meta.total, 21);
    assert.equal(members.data.length, 5);
    const search = await client.community.members.list({ search: "sofia" });
    assert.deepEqual(
      search.data.map((m) => m.id),
      ["member_03"]
    );
    check(
      "get",
      "/community/members/{memberId}",
      200,
      await client.community.members.get("member_02")
    );

    const courses = await client.community.courses.list();
    check("get", "/community/courses", 200, courses);
    assert.deepEqual(
      courses.data.map((item) => item.id),
      ["course_foundations"],
      "drafts and courses not sold through a product are hidden"
    );
    const course = await client.community.courses.get("course_foundations");
    check("get", "/community/courses/{courseId}", 200, course);
    assert.equal(course.data.chapterCount, 2, "empty chapters are skipped");
    assert.equal(course.data.moduleCount, 5);

    const progress = await client.community.members.progress.list("member_03");
    check("get", "/community/members/{memberId}/progress", 200, progress);
    assert.equal(progress.data.length, 3);
    const completed = await client.community.members.progress.complete(
      "member_04",
      "module_setup"
    );
    check(
      "put",
      "/community/members/{memberId}/progress/{moduleId}",
      200,
      completed
    );
    assert.ok(completed.data.completedAt);
    const again = await client.community.members.progress.complete(
      "member_04",
      "module_setup"
    );
    assert.equal(again.data.completedAt, completed.data.completedAt);
    const uncompleted = await client.community.members.progress.uncomplete(
      "member_04",
      "module_setup"
    );
    check(
      "delete",
      "/community/members/{memberId}/progress/{moduleId}",
      200,
      uncompleted
    );
    assert.equal(uncompleted.data.completedAt, null);

    const badge = await client.community.badges.upsert({
      key: "first-post",
      name: "First post",
      color: "#4f46e5",
    });
    check("post", "/community/badges", 201, badge);
    const updatedByKey = await api("POST", "/community/badges", {
      key: "first-post",
      name: "First post!",
      color: "#4f46e5",
    });
    assert.equal(updatedByKey.status, 200);
    check("post", "/community/badges", 200, updatedByKey.body);
    check(
      "get",
      "/community/badges",
      200,
      await client.community.badges.list()
    );
    const patched = await client.community.badges.update(badge.data.id, {
      description: "Posted for the first time.",
    });
    check("patch", "/community/badges/{badgeId}", 200, patched);
    const award = await client.community.members.badges.award(
      "member_02",
      badge.data.id
    );
    check("put", "/community/members/{memberId}/badges/{badgeId}", 200, award);
    const withBadge = await client.community.members.get("member_02");
    assert.equal(withBadge.data.badges[0]?.key, "first-post");
    const revoked = await client.community.members.badges.revoke(
      "member_02",
      badge.data.id
    );
    check(
      "delete",
      "/community/members/{memberId}/badges/{badgeId}",
      200,
      revoked
    );
    assert.equal(revoked.data.revoked, true);
    const deleted = await client.community.badges.delete(badge.data.id);
    check("delete", "/community/badges/{badgeId}", 200, deleted);

    const events = await client.events.list();
    check("get", "/events", 200, events);
    assert.deepEqual(
      events.data.map((event) => event.id),
      ["event_live_qa"]
    );
    const event = await client.events.get("event_live_qa");
    check("get", "/events/{eventId}", 200, event);
    for (const item of [event.data, ...events.data]) {
      assert.ok(!("pipelineId" in item), "apps never get pipelineId");
      assert.ok(!("pipeline" in item), "apps never get pipeline");
    }
    // Linked to `form_intake`, which isn't shown in community.
    assert.equal(event.data.formId, null);
    assert.equal(event.data.form, null);

    const registered = await client.events.registrations.create(
      "event_live_qa",
      {
        memberId: "member_07",
      }
    );
    check("post", "/events/{eventId}/registrations", 201, registered);
    assert.equal(registered.data.created, true);
    assert.ok(registered.data.registration?.contactId, "a contact is created");
    assert.equal(
      (registered.data.registration as Record<string, unknown>).contact,
      undefined,
      "apps never get the expanded contact"
    );
    assert.ok(
      !("opportunityId" in registered.data.registration),
      "apps never get opportunityId"
    );
    const repeat = await api("POST", "/events/event_live_qa/registrations", {
      memberId: "member_07",
    });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.data.created, false);
    check("post", "/events/{eventId}/registrations", 200, repeat.body);

    const attendance = await client.events.attendance.set("event_live_qa", {
      memberId: "member_07",
      attendance: "ATTENDED",
    });
    check("put", "/events/{eventId}/attendance", 200, attendance);
    assert.equal(attendance.data.attendance, "ATTENDED");
    const cancelled = await client.events.registrations.cancel(
      "event_live_qa",
      {
        memberId: "member_07",
      }
    );
    check("delete", "/events/{eventId}/registrations", 200, cancelled);
    assert.equal(cancelled.data.cancelled, true);
    const notRegistered = await client.events.registrations.cancel(
      "event_live_qa",
      {
        memberId: "member_09",
      }
    );
    assert.deepEqual(notRegistered.data, {
      eventId: "event_live_qa",
      contactId: null,
      cancelled: false,
    });

    const forms = await client.forms.list();
    check("get", "/forms", 200, forms);
    assert.deepEqual(
      forms.data.map((form) => form.id),
      ["form_checkin"]
    );
    assert.equal(forms.data[0]?.submissionCount, 1);
    assert.deepEqual(Object.keys(forms.data[0]?.settings ?? {}).sort(), [
      "css",
      "respondent",
      "theme",
    ]);
    const submission = await client.forms.submissions.create("form_checkin", {
      memberId: "member_08",
      fields: { wins: "Shipped the leaderboard", energy: "medium" },
    });
    check("post", "/forms/{formId}/submissions", 201, submission);
    assert.equal(submission.data.source, "EMBED");
    assert.deepEqual(submission.data.fields, {
      wins: "Shipped the leaderboard",
      energy: "medium",
      share: false,
    });
  });

  it("hides what production hides and returns the same errors", async () => {
    const cases: Array<{
      call: () => Promise<Call>;
      status: number;
      error: string;
      spec?: [method: string, path: string];
    }> = [
      {
        call: () => api("GET", "/community/channels/channel_staff/messages"),
        status: 404,
        error: "Channel not found.",
        spec: ["get", "/community/channels/{channelId}/messages"],
      },
      {
        call: () =>
          api("POST", "/community/channels/channel_staff/messages", {
            body: "hi",
          }),
        status: 404,
        error: "Channel not found.",
        spec: ["post", "/community/channels/{channelId}/messages"],
      },
      {
        call: () =>
          api("POST", "/community/channels/channel_announcements/messages", {
            body: "hi",
          }),
        status: 403,
        error: "This app can't post in that channel.",
        spec: ["post", "/community/channels/{channelId}/messages"],
      },
      {
        call: () =>
          api("POST", "/community/channels/channel_app/messages", {
            body: "hi",
          }),
        status: 400,
        error: "Messages can only be posted in text channels.",
      },
      {
        call: () =>
          api("POST", "/community/channels/channel_general/messages", {
            body: "nested",
            replyToId: "msg_0003",
          }),
        status: 400,
        error: "Replies cannot be nested.",
      },
      {
        call: () =>
          api(
            "GET",
            "/community/channels/channel_general/messages?cursor=nope"
          ),
        status: 400,
        error: "Invalid cursor.",
        spec: ["get", "/community/channels/{channelId}/messages"],
      },
      {
        call: () =>
          api("GET", "/community/channels/channel_general/messages?limit=500"),
        status: 400,
        error: "limit must be an integer from 1 to 100.",
      },
      {
        call: () => api("GET", "/community/members/member_99"),
        status: 404,
        error: "Member not found.",
        spec: ["get", "/community/members/{memberId}"],
      },
      {
        call: () => api("GET", "/community/courses/course_advanced"),
        status: 404,
        error: "Course not found.",
        spec: ["get", "/community/courses/{courseId}"],
      },
      {
        call: () =>
          api("PUT", "/community/members/member_02/progress/module_discovery"),
        status: 404,
        error: "Module not found.",
        spec: ["put", "/community/members/{memberId}/progress/{moduleId}"],
      },
      {
        call: () =>
          api("PUT", "/community/members/member_10/progress/module_setup"),
        status: 409,
        error: "Member is not active.",
        spec: ["put", "/community/members/{memberId}/progress/{moduleId}"],
      },
      {
        call: () => api("GET", "/events/event_strategy_workshop"),
        status: 404,
        error: "Event not shown in community.",
        spec: ["get", "/events/{eventId}"],
      },
      {
        call: () => api("GET", "/events/event_missing"),
        status: 404,
        error: "Event not found.",
      },
      {
        call: () =>
          api("POST", "/events/event_strategy_workshop/registrations", {
            memberId: "member_02",
          }),
        status: 404,
        error: "Event not shown in community.",
        spec: ["post", "/events/{eventId}/registrations"],
      },
      {
        call: () =>
          api("POST", "/events/event_live_qa/registrations", {
            memberId: "member_10",
          }),
        status: 409,
        error: "Member is not active.",
        spec: ["post", "/events/{eventId}/registrations"],
      },
      {
        call: () =>
          api("POST", "/events/event_live_qa/registrations", {
            contactId: "contact_02",
          }),
        status: 400,
        error: "Community apps must identify the member with memberId.",
        spec: ["post", "/events/{eventId}/registrations"],
      },
      {
        call: () => api("POST", "/events/event_live_qa/registrations", {}),
        status: 400,
        error: "Community apps must identify the member with memberId.",
      },
      {
        call: () => api("DELETE", "/events/event_live_qa/registrations"),
        status: 400,
        error: "Community apps must identify the member with memberId.",
      },
      {
        call: () =>
          api("PUT", "/events/event_live_qa/attendance", {
            memberId: "member_09",
            attendance: "ATTENDED",
          }),
        status: 404,
        error: "Registration not found.",
        spec: ["put", "/events/{eventId}/attendance"],
      },
      {
        call: () =>
          api("POST", "/forms/form_intake/submissions", {
            memberId: "member_02",
            fields: {},
          }),
        status: 404,
        error: "Form not shown in community.",
        spec: ["post", "/forms/{formId}/submissions"],
      },
      {
        call: () =>
          api("POST", "/forms/form_checkin/submissions", {
            memberId: "member_02",
            fields: { energy: "high" },
          }),
        status: 400,
        error: "Wins this week is required.",
        spec: ["post", "/forms/{formId}/submissions"],
      },
      {
        call: () =>
          api("POST", "/forms/form_checkin/submissions", {
            memberId: "member_14",
            fields: { wins: "x", energy: "high" },
          }),
        status: 409,
        error: "Member is not active.",
      },
      {
        call: () =>
          api("PUT", "/community/members/member_02/badges/badge_missing"),
        status: 404,
        error: "Badge not found.",
      },
      {
        call: () =>
          api("POST", "/events/event_live_qa/registrations", {
            memberId: "member_21",
          }),
        status: 409,
        error: "Member has no primary contact.",
        spec: ["post", "/events/{eventId}/registrations"],
      },
      {
        call: () =>
          api("POST", "/forms/form_checkin/submissions", {
            memberId: "member_21",
            fields: { wins: "x", energy: "high" },
          }),
        status: 409,
        error: "Member has no primary contact.",
        spec: ["post", "/forms/{formId}/submissions"],
      },
      {
        call: () => api("GET", "/community/courses/course_toolkit"),
        status: 404,
        error: "Course not found.",
        spec: ["get", "/community/courses/{courseId}"],
      },
      {
        call: () =>
          api(
            "GET",
            "/community/members/member_02/progress?courseId=course_toolkit"
          ),
        status: 404,
        error: "Course not found.",
        spec: ["get", "/community/members/{memberId}/progress"],
      },
      {
        call: () =>
          api("PUT", "/community/members/member_02/progress/module_planner"),
        status: 404,
        error: "Module not found.",
        spec: ["put", "/community/members/{memberId}/progress/{moduleId}"],
      },
      {
        call: () => api("GET", "/nope"),
        status: 404,
        error: "Not found.",
      },
    ];

    for (const testCase of cases) {
      const { status, body } = await testCase.call();
      assert.equal(status, testCase.status, JSON.stringify(body));
      assert.equal(body.error, testCase.error);
      if (testCase.spec) {
        spec.assertResponse(testCase.spec[0], testCase.spec[1], status, body);
      }
    }

    // Invalid bodies on events/forms routes are `{ error }` with Zod's
    // readable message (`parseApiInput`), not Zod trees.
    const strict = await api("POST", "/events/event_live_qa/registrations", {
      memberId: "member_02",
      extra: true,
    });
    assert.equal(strict.status, 400);
    assert.equal(typeof strict.body.error, "string");
    assert.match(strict.body.error, /extra/);
    assert.equal(strict.body.errors, undefined);
    spec.assertResponse(
      "post",
      "/events/{eventId}/registrations",
      400,
      strict.body
    );
    const badSubmission = await api("POST", "/forms/form_checkin/submissions", {
      memberId: "member_02",
      fields: "nope",
    });
    assert.equal(badSubmission.status, 400);
    assert.match(badSubmission.body.error, /fields/);

    // Malformed JSON on events/forms write routes is 400 `Invalid JSON body.`.
    for (const [method, path, specPath] of [
      [
        "POST",
        "/events/event_live_qa/registrations",
        "/events/{eventId}/registrations",
      ],
      [
        "PUT",
        "/events/event_live_qa/attendance",
        "/events/{eventId}/attendance",
      ],
      [
        "POST",
        "/forms/form_checkin/submissions",
        "/forms/{formId}/submissions",
      ],
    ] as const) {
      const response = await fetch(`${emulator.url}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${emulator.appSecret}`,
          "x-planeward-installation": emulator.installationId,
          "Content-Type": "application/json",
        },
        body: "{not json",
      });
      const body = await response.json();
      assert.equal(response.status, 400, path);
      assert.deepEqual(body, { error: "Invalid JSON body." });
      spec.assertResponse(method.toLowerCase(), specPath, 400, body);
    }

    const channels = (await client.community.channels.list()).data;
    assert.ok(!channels.some((channel) => channel.id === "channel_staff"));
  });

  it("rejects bad credentials with the production 401 bodies", async () => {
    const noKey = await api("GET", "/community/members", undefined, {
      Authorization: "",
    });
    assert.deepEqual(noKey, {
      status: 401,
      body: { error: "Invalid or missing API key" },
    });
    const wrongSecret = await api("GET", "/community/members", undefined, {
      Authorization: "Bearer pwa_wrong",
    });
    assert.deepEqual(wrongSecret.body, {
      error: "Invalid or missing app credentials",
    });
    assert.equal(wrongSecret.status, 401);
    const viaApiKeyHeader = await api("GET", "/community/members", undefined, {
      Authorization: "",
      "x-api-key": emulator.appSecret,
    });
    assert.equal(viaApiKeyHeader.status, 200);
    const noInstallation = await api("GET", "/community/members", undefined, {
      "x-planeward-installation": "",
    });
    assert.equal(noInstallation.status, 401);
  });

  it("answers CORS preflights for the app origin only", async () => {
    const preflight = await fetch(`${emulator.url}/api/v1/community/members`, {
      method: "OPTIONS",
      headers: { Origin: receiver.url },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      receiver.url
    );
    const other = await fetch(`${emulator.url}/api/v1/community/members`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  it("applies activity to the store and fires the matching webhooks", async () => {
    const before = receiver.received.length;

    const posted = await activity({
      type: "message.post",
      memberId: "member_05",
      channelId: "channel_wins",
      body: "Ran my first workshop",
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.body.data.events, ["community.message.created"]);
    await emulator.idle();
    const created = await waitFor(
      () =>
        receiver.received
          .slice(before)
          .find((item) => item.envelope.event === "community.message.created"),
      "community.message.created"
    );
    assert.equal(
      await verifyPlanewardWebhook({
        rawBody: created.rawBody,
        signature: created.headers.signature,
        secret: emulator.webhookSecret,
      }),
      true
    );
    if (created.envelope.event === "community.message.created") {
      assert.equal(created.envelope.data.memberId, "member_05");
      assert.equal(created.envelope.data.authorKind, "member");
    }

    // Completing the last module also completes the course.
    for (const moduleId of ["module_morning", "module_review"]) {
      await activity({
        type: "module.complete",
        memberId: "member_03",
        moduleId,
      });
    }
    const last = await activity({
      type: "module.complete",
      memberId: "member_03",
      moduleId: "module_reflect",
    });
    assert.deepEqual(last.body.data.events, [
      "community.module.completed",
      "community.course.completed",
    ]);

    // `community.course.completed` goes out once per member and course:
    // completing the last module again doesn't repeat it, and member_02's
    // seeded completion already counted.
    for (const memberId of ["member_03", "member_02"]) {
      await activity({
        type: "module.uncomplete",
        memberId,
        moduleId: "module_reflect",
      });
      const again = await activity({
        type: "module.complete",
        memberId,
        moduleId: "module_reflect",
      });
      assert.deepEqual(again.body.data.events, ["community.module.completed"]);
    }

    // Private channel and unflagged event: recorded, never sent.
    const hidden = await activity({
      type: "message.post",
      memberId: "member_01",
      channelId: "channel_staff",
      body: "staff only",
    });
    const deliveries = await local<WebhookDeliveryListResponse>(
      "GET",
      EMULATOR_ROUTES.deliveries
    );
    const hiddenEntry = deliveries.body.data.find(
      (entry) => entry.id === hidden.body.data.deliveryIds[0]
    );
    assert.equal(hiddenEntry?.status, "skipped");
    assert.equal(hiddenEntry?.skippedReason, HIDDEN_CHANNEL_REASON);

    const rsvp = await activity({
      type: "event.rsvp",
      memberId: "member_11",
      eventId: "event_strategy_workshop",
    });
    const rsvpEntry = (
      await local<WebhookDeliveryListResponse>(
        "GET",
        EMULATOR_ROUTES.deliveries
      )
    ).body.data.find((entry) => entry.id === rsvp.body.data.deliveryIds[0]);
    assert.equal(rsvpEntry?.skippedReason, UNFLAGGED_EVENT_REASON);

    await emulator.idle();
    assert.ok(
      !receiver.received.some(
        (item) =>
          item.envelope.event === "community.message.created" &&
          item.envelope.data.channelId === "channel_staff"
      )
    );

    // Membership changes and member writes on inactive members.
    const suspend = await activity({
      type: "membership.suspend",
      memberId: "member_20",
    });
    assert.deepEqual(suspend.body.data.events, [
      "community.membership.suspended",
    ]);
    const blocked = await activity({
      type: "message.post",
      memberId: "member_20",
      channelId: "channel_general",
      body: "hi",
    });
    assert.equal(blocked.status, 409);

    const granted = await activity({
      type: "membership.grant",
      displayName: "New Person",
      email: "new.person@example.com",
    });
    assert.deepEqual(granted.body.data.events, [
      "community.membership.granted",
    ]);
    assert.ok(
      granted.body.data.state.entities.members.some(
        (m) => m.displayName === "New Person"
      )
    );
  });

  it("redelivers with the same delivery id", async () => {
    await emulator.idle();
    const list = await local<WebhookDeliveryListResponse>(
      "GET",
      EMULATOR_ROUTES.deliveries
    );
    const original = list.body.data.find(
      (entry) =>
        entry.status === "succeeded" &&
        entry.event === "community.message.created"
    )!;
    const { status, body } = await local<WebhookDeliveryResponse>(
      "POST",
      emulatorPath(EMULATOR_ROUTES.redeliver, { deliveryId: original.id })
    );
    assert.equal(status, 200);
    assert.notEqual(body.data.id, original.id);
    assert.equal(body.data.deliveryId, original.deliveryId);
    assert.equal(body.data.redeliveryOf, original.id);
    await emulator.idle();
    const copies = receiver.received.filter(
      (item) => item.headers.delivery === original.deliveryId
    );
    assert.equal(copies.length, 2);
    assert.equal(copies[0]!.rawBody, copies[1]!.rawBody);

    const after = await local<WebhookDeliveryListResponse>(
      "GET",
      `${EMULATOR_ROUTES.deliveries}?after=${original.id}`
    );
    assert.ok(after.body.data.every((entry) => entry.id !== original.id));
    assert.equal(after.body.data.at(-1)?.id, body.data.id, "oldest first");
  });

  it("logs every API request with its route and scope", async () => {
    await api("GET", "/events/event_live_qa");
    const { body } = await local<ApiRequestLogResponse>(
      "GET",
      EMULATOR_ROUTES.requests
    );
    const entry = body.data.at(-1)!;
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/api/v1/events/event_live_qa");
    assert.equal(entry.route, "/api/v1/events/:eventId");
    assert.equal(entry.scope, "EVENTS_READ");
    assert.equal(entry.status, 200);
    assert.equal(
      (entry.responseBody as { data: { id: string } }).data.id,
      "event_live_qa"
    );

    await api("POST", "/forms/form_checkin/submissions", {
      memberId: "member_02",
      fields: {},
    });
    const posted = (
      await local<ApiRequestLogResponse>("GET", EMULATOR_ROUTES.requests)
    ).body.data.at(-1)!;
    assert.deepEqual(posted.requestBody, { memberId: "member_02", fields: {} });
    assert.equal(posted.status, 400);
  });

  it("streams state, request and delivery updates over SSE", async () => {
    const controller = new AbortController();
    const response = await fetch(`${emulator.url}${EMULATOR_ROUTES.stream}`, {
      signal: controller.signal,
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const read = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      return text.includes(needle);
    };
    assert.ok(await read("event: state"));
    await api("GET", "/community/members/member_02");
    assert.ok(await read("event: request"));
    controller.abort();
  });

  it("refuses cross-site calls to the emulator routes", async () => {
    const { status } = await local("GET", EMULATOR_ROUTES.state, undefined, {
      Origin: "https://evil.example",
    });
    assert.equal(status, 403);
  });

  it("triggers events from the current state", async () => {
    const entry = await emulator.trigger("event.registered", {
      memberId: "member_02",
    });
    assert.equal(entry.status, "succeeded");
    assert.equal(entry.envelope.event, "event.registered");
    assert.throws(
      () =>
        emulator.instance.trigger("community.badge.awarded", {
          memberId: "member_02",
        }),
      TriggerError
    );
    assert.throws(
      () =>
        emulator.instance.trigger("community.membership.granted", {
          memberId: "member_x",
        }),
      TriggerError
    );
  });

  it("persists state to state.json and reseeds on reset", async () => {
    await emulator.instance.store.flush();
    const saved = JSON.parse(
      await readFile(join(stateDir, STATE_FILE_NAME), "utf8")
    );
    assert.ok(
      saved.entities.members.some(
        (m: { displayName: string }) => m.displayName === "New Person"
      )
    );

    const reopened = await startEmulator({
      manifest: manifestFor(receiver.url),
      stateDir,
      port: 0,
    });
    try {
      assert.equal(reopened.fresh, false);
      assert.equal(reopened.appSecret, emulator.appSecret, "keys are reused");
      assert.ok(
        reopened.instance.store.entities.members.some(
          (m) => m.displayName === "New Person"
        )
      );
      const reset = await emulatorCaller(reopened)<{
        data: { entities: { members: unknown[] } };
      }>("POST", EMULATOR_ROUTES.reset);
      assert.equal(reset.body.data.entities.members.length, 21);
    } finally {
      await reopened.close();
    }

    const reseeded = await startEmulator({
      manifest: manifestFor(receiver.url),
      stateDir,
      port: 0,
      reset: true,
    });
    try {
      assert.equal(reseeded.fresh, true);
    } finally {
      await reseeded.idle();
      await reseeded.close();
    }
  });
});

describe("emulator scope enforcement", () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let emulator: RunningEmulator;
  let spec: OpenApiValidator;

  before(async () => {
    spec = loadOpenApiValidator();
    receiver = await startReceiver();
    emulator = await startEmulator({
      manifest: manifestFor(receiver.url, {
        scopes: ["COMMUNITY_MEMBERS_READ", "COURSE_PROGRESS_WRITE"],
        webhookPath: undefined,
      }),
      stateDir: null,
      port: 0,
    });
  });

  after(async () => {
    await emulator?.close();
    await receiver?.close();
  });

  it("answers a missing scope with 403 and missingScope", async () => {
    const api = apiCaller(emulator);
    const events = await api("GET", "/events");
    assert.deepEqual(events, {
      status: 403,
      body: {
        error: "Insufficient API key permissions",
        missingScope: "EVENTS_READ",
      },
    });
    spec.assertResponse("get", "/events", 403, events.body);

    const channels = await api("GET", "/community/channels");
    assert.equal(channels.body.missingScope, "COMMUNITY_MESSAGES_READ");

    const client = createPlanewardClient({
      secret: emulator.appSecret,
      installationId: emulator.installationId,
      baseUrl: emulator.url,
    });
    await assert.rejects(client.forms.list(), (error: unknown) => {
      assert.ok(error instanceof PlanewardApiError);
      assert.equal(error.status, 403);
      assert.equal(error.missingScope, "FORMS_SUBMIT");
      return true;
    });

    // COURSE_PROGRESS_WRITE implies COURSES_READ.
    assert.equal((await api("GET", "/community/courses")).status, 200);

    const log = await emulatorCaller(emulator)<ApiRequestLogResponse>(
      "GET",
      EMULATOR_ROUTES.requests
    );
    const denied = log.body.data.find(
      (entry) => entry.path === "/api/v1/events"
    )!;
    assert.equal(denied.missingScope, "EVENTS_READ");
    assert.equal(denied.status, 403);
  });

  it("skips webhooks the installation can't receive", async () => {
    const local = emulatorCaller(emulator);
    const posted = await local<ActivityResponse>(
      "POST",
      EMULATOR_ROUTES.activity,
      {
        type: "message.post",
        memberId: "member_02",
        channelId: "channel_general",
        body: "hello",
      } satisfies ActivityAction
    );
    const deliveries = await local<WebhookDeliveryListResponse>(
      "GET",
      EMULATOR_ROUTES.deliveries
    );
    const entry: WebhookDeliveryEntry | undefined = deliveries.body.data.find(
      (item) => item.id === posted.body.data.deliveryIds[0]
    );
    assert.equal(entry?.status, "skipped");
    assert.equal(
      entry?.skippedReason,
      "Installation is not granted COMMUNITY_MESSAGES_READ."
    );

    // Granted, but no webhookPath in the manifest.
    const suspended = await local<ActivityResponse>(
      "POST",
      EMULATOR_ROUTES.activity,
      {
        type: "membership.suspend",
        memberId: "member_02",
      } satisfies ActivityAction
    );
    const membership = (
      await local<WebhookDeliveryListResponse>(
        "GET",
        EMULATOR_ROUTES.deliveries
      )
    ).body.data.find((item) => item.id === suspended.body.data.deliveryIds[0]);
    assert.equal(membership?.status, "skipped");
    assert.match(membership?.skippedReason ?? "", /webhookPath/);
    assert.equal(receiver.received.length, 0);
  });

  it("serves a placeholder page until the UI is built", async () => {
    const empty = await mkdtemp(join(tmpdir(), "planeward-ui-"));
    const placeholder = await startEmulator({
      manifest: manifestFor(receiver.url),
      stateDir: null,
      port: 0,
      uiDir: empty,
    });
    try {
      const response = await fetch(`${placeholder.url}/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /pnpm build/);
      const jwks = (await (
        await fetch(`${placeholder.url}/api/auth/jwks`)
      ).json()) as {
        keys: Array<{ kid: string; alg: string }>;
      };
      assert.equal(jwks.keys[0]?.alg, "RS256");
    } finally {
      await placeholder.idle();
      await placeholder.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});
