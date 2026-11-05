/**
 * Every webhook `data` the emulator emits has exactly the fields apps get in
 * production. The key lists are checked against the SDK's
 * `AppWebhookEventDataMap` at compile time and mirror the workbench zod
 * schemas (`apps/web/src/config/webhook/webhook-event-payloads.ts`: the
 * community schemas, `appEventRegistrationSchema` and
 * `appFormSubmittedSchema`), which can't be imported from here.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { AppWebhookEventDataMap } from "@planeward/sdk/server";

import { APP_GRANTABLE_SCOPES } from "../../manifest";
import {
  EMULATOR_WEBHOOK_EVENTS,
  type EmulatorWebhookEventName,
  type FixtureMember,
} from "../contract";
import type { Domain, DomainEvent } from "./domain";
import { createEmulatorApp } from "./index";
import { appInstalledEvent, buildTriggerEvent } from "./trigger";

const EXPECTED_KEYS = {
  "app.installed": [
    "installationId",
    "workspaceId",
    "workspaceName",
    "grantedPermissions",
    "installedAt",
  ],
  "app.uninstalled": ["installationId", "workspaceId", "uninstalledAt"],
  "community.membership.granted": [
    "id",
    "communityId",
    "customerId",
    "source",
    "status",
  ],
  "community.membership.suspended": [
    "id",
    "communityId",
    "customerId",
    "source",
    "status",
  ],
  "community.membership.resumed": [
    "id",
    "communityId",
    "customerId",
    "source",
    "status",
  ],
  "community.membership.revoked": [
    "id",
    "communityId",
    "customerId",
    "source",
    "status",
  ],
  "community.message.created": [
    "id",
    "communityId",
    "channelId",
    "replyToId",
    "authorKind",
    "memberId",
    "appInstallationId",
    "authorName",
    "body",
    "createdAt",
  ],
  "community.message.deleted": [
    "id",
    "communityId",
    "channelId",
    "memberId",
    "timestamp",
  ],
  "community.reaction.added": [
    "messageId",
    "communityId",
    "channelId",
    "emoji",
    "memberId",
    "timestamp",
  ],
  "community.reaction.removed": [
    "messageId",
    "communityId",
    "channelId",
    "emoji",
    "memberId",
    "timestamp",
  ],
  "community.module.completed": [
    "moduleId",
    "moduleTitle",
    "chapterId",
    "courseId",
    "courseTitle",
    "communityId",
    "memberId",
    "completedAt",
  ],
  "community.course.completed": [
    "courseId",
    "courseTitle",
    "communityId",
    "memberId",
    "completedAt",
  ],
  "event.registered": ["id", "eventId", "contactId", "memberId", "attendance"],
  "event.registration_cancelled": [
    "id",
    "eventId",
    "contactId",
    "memberId",
    "attendance",
  ],
  "event.attendance_classified": [
    "id",
    "eventId",
    "contactId",
    "memberId",
    "attendance",
  ],
  "form.submitted": ["id", "formId", "contactId", "memberId", "source"],
  "community.badge.awarded": [
    "badgeId",
    "badgeKey",
    "appId",
    "memberId",
    "timestamp",
  ],
  "community.badge.revoked": [
    "badgeId",
    "badgeKey",
    "appId",
    "memberId",
    "timestamp",
  ],
} as const satisfies {
  [K in EmulatorWebhookEventName]: readonly (keyof AppWebhookEventDataMap[K])[];
};

// Compile-time: every SDK field is listed (`satisfies` above rules out extras).
type Unlisted = {
  [K in EmulatorWebhookEventName]: Exclude<
    keyof AppWebhookEventDataMap[K],
    (typeof EXPECTED_KEYS)[K][number]
  >;
}[EmulatorWebhookEventName];
const everySdkFieldListed: [Unlisted] extends [never] ? true : false = true;

function assertPayload(event: DomainEvent) {
  assert.deepEqual(
    Object.keys(event.data).sort(),
    [...EXPECTED_KEYS[event.event]].sort(),
    `${event.event} data keys`
  );
}

describe("webhook payloads", () => {
  let domain: Domain;
  let member: FixtureMember;

  before(async () => {
    const instance = await createEmulatorApp({
      manifest: {
        name: "Leaderboard",
        slug: "leaderboard",
        experiencePath: "/experience",
        webhookPath: "/api/webhooks/planeward",
        scopes: [...APP_GRANTABLE_SCOPES],
        dev: { command: "true", url: "http://127.0.0.1:9" },
      },
      stateDir: null,
      reset: true,
    });
    domain = instance.domain;
    member = domain.member("member_02")!;
  });

  it("lists every SDK field", () => {
    assert.equal(everySdkFieldListed, true);
    assert.deepEqual(
      Object.keys(EXPECTED_KEYS).sort(),
      [...EMULATOR_WEBHOOK_EVENTS].sort()
    );
  });

  it("triggers every event with exactly the production fields", () => {
    domain.upsertBadge({
      key: "streak",
      name: "Streak",
      description: "",
      color: "#7c3aed",
    });
    assertPayload(appInstalledEvent(domain.store));
    for (const name of EMULATOR_WEBHOOK_EVENTS) {
      assertPayload(buildTriggerEvent(domain, name, { memberId: member.id }));
    }
  });

  it("emits event.* from mutations with the member of the contact", () => {
    const event = domain.store.entities.events.find(
      (item) => !domain.registrationFor(item, member.contactId)
    )!;
    const emitted: DomainEvent[] = [
      ...domain.register(event, member).events,
      ...domain.setAttendance(event, member, { attendance: "ATTENDED" }).events,
      ...domain.cancelRegistration(event, member).events,
    ];
    assert.deepEqual(
      emitted.map((item) => item.event),
      [
        "event.registered",
        "event.attendance_classified",
        "event.registration_cancelled",
      ]
    );
    for (const item of emitted) {
      assertPayload(item);
      assert.equal(
        (item.data as AppWebhookEventDataMap["event.registered"]).memberId,
        member.id
      );
    }
  });

  it("emits form.submitted with memberId and no CRM ids", () => {
    const form = domain.form("form_checkin")!;
    const { events } = domain.submitForm({
      form,
      member,
      fields: { wins: "Shipped.", energy: "high", share: true },
      source: "HOST",
    });
    const submitted = events.find((item) => item.event === "form.submitted")!;
    assertPayload(submitted);
    assert.equal(
      (submitted.data as AppWebhookEventDataMap["form.submitted"]).memberId,
      member.id
    );
    for (const item of events) assertPayload(item);
  });

  it("resolves memberId to null for a contact no member has", () => {
    assert.equal(domain.memberIdForContact("contact_unknown"), null);
    assert.equal(domain.memberIdForContact(null), null);
    assert.equal(domain.memberIdForContact(member.contactId), member.id);
  });
});
