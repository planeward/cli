import type { EmulatorWebhookEventName, FixtureMember } from "../contract";
import type { Domain, DomainEvent } from "./domain";
import { EMULATOR_COMMUNITY_ID, EMULATOR_WORKSPACE_NAME } from "./fixtures";
import { orderedScopes } from "./scopes";
import type { EmulatorStore } from "./store";

export type TriggerOptions = {
  /** Member the event is about; defaults to the current viewer. */
  memberId?: string;
};

/** Thrown for a trigger that can't be built from the current state. */
export class TriggerError extends Error {
  override readonly name = "TriggerError";
}

export function appInstalledEvent(store: EmulatorStore): DomainEvent {
  return {
    event: "app.installed",
    data: {
      installationId: store.app.installationId,
      workspaceId: store.app.workspaceId,
      workspaceName: EMULATOR_WORKSPACE_NAME,
      grantedPermissions: orderedScopes(store.app.scopes),
      installedAt: store.installedAt,
    },
    filteredReason: null,
  };
}

/**
 * Builds one event from the current state without changing it (except that
 * a member without a contact gets one, as an RSVP would). Uses the member's
 * own data where it exists: their latest message, completed module,
 * registration, submission or badge.
 */
export function buildTriggerEvent(
  domain: Domain,
  event: EmulatorWebhookEventName,
  options: TriggerOptions = {}
): DomainEvent {
  const store = domain.store;
  const { entities } = store;
  const member: FixtureMember | undefined = options.memberId
    ? domain.member(options.memberId)
    : domain.member(store.viewer.memberId);
  if (!member) {
    throw new TriggerError(
      options.memberId
        ? `No member "${options.memberId}".`
        : "The current viewer is not a member."
    );
  }
  const now = store.nowIso();
  const latest = <T extends { createdAt: string }>(rows: T[]) =>
    [...rows].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    )[0];

  switch (event) {
    case "app.installed":
      return appInstalledEvent(store);
    case "app.uninstalled":
      return {
        event,
        data: {
          installationId: store.app.installationId,
          workspaceId: store.app.workspaceId,
          uninstalledAt: now,
        },
        filteredReason: null,
      };
    case "community.membership.granted":
    case "community.membership.resumed":
    case "community.membership.suspended":
    case "community.membership.revoked": {
      const status =
        event === "community.membership.suspended"
          ? "SUSPENDED"
          : event === "community.membership.revoked"
            ? "REVOKED"
            : "ACTIVE";
      return {
        event,
        data: { ...domain.membershipData(member), status },
        filteredReason: null,
      };
    }
    case "community.message.created":
    case "community.message.deleted": {
      const visible = entities.messages.filter(
        (message) => domain.channel(message.channelId)?.everyone.view
      );
      const message =
        latest(visible.filter((item) => item.author.memberId === member.id)) ??
        latest(visible);
      if (!message) throw new TriggerError("There are no messages yet.");
      if (event === "community.message.created") {
        return {
          event,
          data: {
            id: message.id,
            communityId: EMULATOR_COMMUNITY_ID,
            channelId: message.channelId,
            replyToId: message.replyToId,
            authorKind: message.author.kind,
            memberId: message.author.memberId,
            appInstallationId: message.author.installationId,
            authorName: message.author.name,
            body: message.body,
            createdAt: message.createdAt,
          },
          filteredReason: null,
        };
      }
      return {
        event,
        data: {
          id: message.id,
          communityId: EMULATOR_COMMUNITY_ID,
          channelId: message.channelId,
          memberId: message.author.memberId,
          timestamp: message.deletedAt ?? now,
        },
        filteredReason: null,
      };
    }
    case "community.reaction.added":
    case "community.reaction.removed": {
      const visible = entities.messages.filter(
        (message) =>
          !message.deletedAt && domain.channel(message.channelId)?.everyone.view
      );
      const reacted = latest(
        visible.filter((message) =>
          message.reactions.some((reaction) => reaction.memberId === member.id)
        )
      );
      const message = reacted ?? latest(visible);
      if (!message) throw new TriggerError("There are no messages yet.");
      const emoji =
        message.reactions.find((reaction) => reaction.memberId === member.id)
          ?.emoji ?? "👍";
      return {
        event,
        data: {
          messageId: message.id,
          communityId: EMULATOR_COMMUNITY_ID,
          channelId: message.channelId,
          emoji,
          memberId: member.id,
          timestamp: now,
        },
        filteredReason: null,
      };
    }
    case "community.module.completed":
    case "community.course.completed": {
      const modules = domain.visibleModules();
      const completed = domain
        .memberProgress(member.id)
        .filter((row) => row.completedAt)
        .sort((left, right) =>
          right.completedAt!.localeCompare(left.completedAt!)
        )[0];
      const ref =
        modules.find((item) => item.moduleId === completed?.moduleId) ??
        modules[0];
      if (!ref)
        throw new TriggerError(
          "There are no published courses sold through a product."
        );
      const completedAt = completed?.completedAt ?? now;
      if (event === "community.module.completed") {
        return {
          event,
          data: {
            moduleId: ref.moduleId,
            moduleTitle: ref.moduleTitle,
            chapterId: ref.chapterId,
            courseId: ref.course.id,
            courseTitle: ref.course.title,
            communityId: EMULATOR_COMMUNITY_ID,
            memberId: member.id,
            completedAt,
          },
          filteredReason: null,
        };
      }
      return {
        event,
        data: {
          courseId: ref.course.id,
          courseTitle: ref.course.title,
          communityId: EMULATOR_COMMUNITY_ID,
          memberId: member.id,
          completedAt,
        },
        filteredReason: null,
      };
    }
    case "event.registered":
    case "event.registration_cancelled":
    case "event.attendance_classified": {
      const flagged = entities.events.filter((item) => item.showInCommunity);
      const own = flagged
        .map((item) => ({
          event: item,
          registration: domain.registrationFor(item, member.contactId),
        }))
        .find((item) => item.registration);
      const target = own?.event ?? flagged[0];
      if (!target) {
        throw new TriggerError("There are no events shown in community.");
      }
      const registration = own?.registration ?? {
        id: store.nextId("registration"),
        contactId: domain.ensureContact(member),
        attendance: "PENDING" as const,
      };
      return {
        event,
        data: {
          id: registration.id,
          eventId: target.id,
          contactId: registration.contactId,
          memberId: domain.memberIdForContact(registration.contactId),
          attendance: registration.attendance,
        },
        filteredReason: null,
      };
    }
    case "form.submitted": {
      const flagged = entities.forms.filter(
        (form) => form.showInCommunity && form.status === "PUBLISHED"
      );
      const submissions = flagged.flatMap((form) => form.submissions);
      const submission =
        latest(
          submissions.filter((item) => item.customerId === member.customerId)
        ) ?? null;
      const form = flagged[0];
      if (!submission && !form) {
        throw new TriggerError("There are no forms shown in community.");
      }
      return {
        event,
        data: submission
          ? {
              id: submission.id,
              formId: submission.formId,
              contactId: submission.contactId,
              memberId: domain.memberIdForContact(submission.contactId),
              source: submission.source,
            }
          : {
              id: store.nextId("submission"),
              formId: form!.id,
              contactId: domain.ensureContact(member),
              memberId: member.id,
              source: "EMBED",
            },
        filteredReason: null,
      };
    }
    case "community.badge.awarded":
    case "community.badge.revoked": {
      const award = [...member.badges].sort((left, right) =>
        right.awardedAt.localeCompare(left.awardedAt)
      )[0];
      const badge = award ?? entities.badges[0];
      if (!badge) {
        throw new TriggerError(
          "The app has no badges yet; create one with POST /api/v1/community/badges."
        );
      }
      return {
        event,
        data: domain.badgeEventData(
          { id: badge.id, key: badge.key, appId: badge.appId },
          member.id
        ),
        filteredReason: null,
      };
    }
  }
}
