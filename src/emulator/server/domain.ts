/**
 * Store mutations shared by the mock API and the Activity panel. Each returns
 * the webhook events it produced; the caller hands them to the dispatcher.
 * Rules and messages mirror Planeward (`server/api/v1/*`, `server/crm/*`,
 * `server/community/*`).
 */
import type { AppWebhookEventDataMap } from "@planeward/sdk/server";

import { communityAppChannelHref } from "../app-path";
import type {
  AttendanceStatus,
  CommunityMemberStatus,
  CommunityMessageAuthor,
  CommunityModuleProgress,
  CommunityNotificationSendResult,
  EmulatorWebhookEventName,
  EventRegistration,
  FixtureBadge,
  FixtureChannel,
  FixtureCourse,
  FixtureEvent,
  FixtureForm,
  FixtureMember,
  FixtureMessage,
  FixtureNotification,
  FormSubmission,
} from "../contract";
import {
  ApiError,
  BADGE_NOT_FOUND_ERROR,
  CHANNEL_NOT_FOUND_ERROR,
  MEMBER_NO_PRIMARY_CONTACT_ERROR,
  MEMBER_NOT_ACTIVE_ERROR,
  MEMBER_NOT_FOUND_ERROR,
  MESSAGE_NOT_FOUND_ERROR,
  MODULE_NOT_FOUND_ERROR,
  REGISTRATION_NOT_FOUND_ERROR,
} from "./errors";
import { EMULATOR_COMMUNITY_ID } from "./fixtures";
import { validateFormAnswers, type FormDefinition } from "./form-answers";
import { toMemberBadge } from "./serialize";
import type { EmulatorStore } from "./store";

/** A webhook event a mutation produced. */
export type DomainEvent = {
  [K in EmulatorWebhookEventName]: {
    event: K;
    data: AppWebhookEventDataMap[K];
    /**
     * Set when production would not send it to apps at all (private channel,
     * unflagged event or form); the delivery is recorded as skipped.
     */
    filteredReason: string | null;
  };
}[EmulatorWebhookEventName];

export const HIDDEN_CHANNEL_REASON =
  "Channel is hidden from @everyone, so apps don't get its events.";
export const UNFLAGGED_EVENT_REASON =
  "Event is not shown in community, so apps don't get its events.";
export const UNFLAGGED_FORM_REASON =
  "Form is not shown in community, so apps don't get its submissions.";

// `server/community/badges.ts`.
export const COMMUNITY_BADGE_LIMIT_PER_APP = 50;
export const COMMUNITY_BADGE_KEY_MAX_LENGTH = 48;
export const COMMUNITY_BADGE_NAME_MAX_LENGTH = 40;
export const COMMUNITY_BADGE_DESCRIPTION_MAX_LENGTH = 200;
export const BADGE_LIMIT_ERROR = `This app already has ${COMMUNITY_BADGE_LIMIT_PER_APP} badges in this workspace, the most it can have. Delete a badge or reuse an existing key.`;

// `config/app/community-apps.ts` (`COMMUNITY_APP_NOTIFICATION_*`).
export const COMMUNITY_NOTIFICATION_MEMBER_LIMIT = 100;
export const COMMUNITY_NOTIFICATION_MEMBER_ID_MAX_LENGTH = 128;
export const COMMUNITY_NOTIFICATION_BODY_MAX_LENGTH = 280;
export const COMMUNITY_NOTIFICATION_KEY_MAX_LENGTH = 100;
/** Notifications one app may send one member in a rolling hour. */
export const COMMUNITY_NOTIFICATION_HOURLY_LIMIT = 10;
export const COMMUNITY_NOTIFICATION_LIMIT_WINDOW_MS = 60 * 60 * 1000;
/** How long a `key` stops the app notifying the same member again. */
export const COMMUNITY_NOTIFICATION_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;

const MONTHLY_PLAN = { id: "plan_monthly", name: "Monthly membership" };

type ModuleRef = {
  course: FixtureCourse;
  chapterId: string;
  moduleId: string;
  moduleTitle: string;
};

export class Domain {
  constructor(readonly store: EmulatorStore) {}

  get #entities() {
    return this.store.entities;
  }

  // Members ------------------------------------------------------------------

  member(memberId: string): FixtureMember | undefined {
    return this.#entities.members.find((member) => member.id === memberId);
  }

  /** `resolveApiMember`: 404 when missing, 409 when `requireActive` and not ACTIVE. */
  requireMember(
    memberId: string,
    options: { requireActive: boolean }
  ): FixtureMember {
    const member = this.member(memberId);
    if (!member) throw new ApiError(MEMBER_NOT_FOUND_ERROR, 404);
    if (options.requireActive && member.status !== "ACTIVE") {
      throw new ApiError(MEMBER_NOT_ACTIVE_ERROR, 409);
    }
    return member;
  }

  /**
   * `memberIdForContact` in `server/apps/webhooks.ts`: the member whose
   * customer has this contact as primary contact, or null.
   */
  memberIdForContact(contactId: string | null): string | null {
    if (!contactId) return null;
    return (
      this.#entities.members.find((member) => member.contactId === contactId)
        ?.id ?? null
    );
  }

  /**
   * `ensureMemberContact`: the member's contact, created on first use. 409
   * when the customer has no email and other contacts (`contactConflict`).
   */
  ensureContact(member: FixtureMember): string {
    if (!member.contactId) {
      if (member.contactConflict) {
        throw new ApiError(MEMBER_NO_PRIMARY_CONTACT_ERROR, 409);
      }
      member.contactId = this.store.nextId("contact");
      this.store.changed();
    }
    return member.contactId;
  }

  membershipData(member: FixtureMember) {
    return {
      id: member.id,
      communityId: EMULATOR_COMMUNITY_ID,
      customerId: member.customerId,
      source:
        member.accessPlans.length > 0
          ? ("SUBSCRIPTION" as const)
          : ("COMPLIMENTARY" as const),
      status: member.status,
    };
  }

  grantMembership(input: { displayName: string; email: string }) {
    const displayName = input.displayName.trim();
    const email = input.email.trim();
    if (!displayName) throw new ApiError("Name is required.", 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError("Enter a valid email.", 400);
    }
    const member: FixtureMember = {
      id: this.store.nextId("member"),
      customerId: this.store.nextId("customer"),
      username: null,
      displayName,
      avatarUrl: null,
      status: "ACTIVE",
      accessPlans: [MONTHLY_PLAN],
      roles: [],
      badges: [],
      joinedAt: this.store.nowIso(),
      email,
      contactId: null,
      contactConflict: false,
    };
    this.#entities.members.push(member);
    this.store.changed();
    return {
      member,
      events: [
        {
          event: "community.membership.granted",
          data: this.membershipData(member),
          filteredReason: null,
        },
      ] satisfies DomainEvent[],
    };
  }

  /** Suspend (from ACTIVE), resume (from SUSPENDED) or revoke (from either). */
  setMembershipStatus(
    member: FixtureMember,
    action: "suspend" | "resume" | "revoke"
  ) {
    const transitions: Record<
      typeof action,
      {
        from: CommunityMemberStatus[];
        to: CommunityMemberStatus;
        event: DomainEvent["event"];
      }
    > = {
      suspend: {
        from: ["ACTIVE"],
        to: "SUSPENDED",
        event: "community.membership.suspended",
      },
      resume: {
        from: ["SUSPENDED"],
        to: "ACTIVE",
        event: "community.membership.resumed",
      },
      revoke: {
        from: ["ACTIVE", "SUSPENDED"],
        to: "REVOKED",
        event: "community.membership.revoked",
      },
    };
    const transition = transitions[action];
    if (!transition.from.includes(member.status)) {
      throw new ApiError(
        `Member is ${member.status.toLowerCase()}; can't ${action}.`,
        409
      );
    }
    member.status = transition.to;
    this.store.changed();
    return {
      member,
      events: [
        {
          event: transition.event,
          data: this.membershipData(member),
          filteredReason: null,
        } as DomainEvent,
      ],
    };
  }

  // Channels and messages ----------------------------------------------------

  channel(channelId: string): FixtureChannel | undefined {
    return this.#entities.channels.find((channel) => channel.id === channelId);
  }

  #channelFilter(channelId: string) {
    return this.channel(channelId)?.everyone.view
      ? null
      : HIDDEN_CHANNEL_REASON;
  }

  /** `insertCommunityChannelMessage`: text channels only, one level of replies. */
  postMessage(input: {
    channelId: string;
    body: string;
    replyToId: string | null;
    author: CommunityMessageAuthor;
  }) {
    const channel = this.channel(input.channelId);
    if (!channel) throw new ApiError(CHANNEL_NOT_FOUND_ERROR, 404);
    if (channel.kind !== "TEXT") {
      throw new ApiError("Messages can only be posted in text channels.", 400);
    }
    if (input.replyToId) {
      const parent = this.#entities.messages.find(
        (message) =>
          message.id === input.replyToId && message.channelId === channel.id
      );
      if (!parent) throw new ApiError("Reply target not found.", 404);
      if (parent.replyToId) {
        throw new ApiError("Replies cannot be nested.", 400);
      }
    }

    const message: FixtureMessage = {
      id: this.store.nextId("msg"),
      channelId: channel.id,
      body: input.body,
      replyToId: input.replyToId,
      createdAt: this.store.nowIso(),
      editedAt: null,
      author: input.author,
      reactions: [],
      deletedAt: null,
    };
    this.#entities.messages.push(message);
    this.store.changed();

    return {
      message,
      events: [
        {
          event: "community.message.created",
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
          filteredReason: this.#channelFilter(channel.id),
        },
      ] satisfies DomainEvent[],
    };
  }

  #liveMessage(messageId: string): FixtureMessage {
    const message = this.#entities.messages.find(
      (item) => item.id === messageId && !item.deletedAt
    );
    if (!message) throw new ApiError(MESSAGE_NOT_FOUND_ERROR, 404);
    return message;
  }

  deleteMessage(messageId: string) {
    const message = this.#liveMessage(messageId);
    message.deletedAt = this.store.nowIso();
    this.store.changed();
    return {
      events: [
        {
          event: "community.message.deleted",
          data: {
            id: message.id,
            communityId: EMULATOR_COMMUNITY_ID,
            channelId: message.channelId,
            memberId: message.author.memberId,
            timestamp: message.deletedAt,
          },
          filteredReason: this.#channelFilter(message.channelId),
        },
      ] satisfies DomainEvent[],
    };
  }

  /** Adds or removes the member's reaction; no event when nothing changed. */
  setReaction(input: {
    member: FixtureMember;
    messageId: string;
    emoji: string;
    present: boolean;
  }) {
    const emoji = input.emoji.trim();
    if (!emoji || emoji.length > 32) {
      throw new ApiError("Reaction emoji is required.", 400);
    }
    const message = this.#liveMessage(input.messageId);
    const index = message.reactions.findIndex(
      (reaction) =>
        reaction.emoji === emoji && reaction.memberId === input.member.id
    );
    const events: DomainEvent[] = [];
    if (input.present === (index !== -1)) return { events };

    if (input.present) {
      message.reactions.push({ emoji, memberId: input.member.id });
    } else {
      message.reactions.splice(index, 1);
    }
    this.store.changed();
    events.push({
      event: input.present
        ? "community.reaction.added"
        : "community.reaction.removed",
      data: {
        messageId: message.id,
        communityId: EMULATOR_COMMUNITY_ID,
        channelId: message.channelId,
        emoji,
        memberId: input.member.id,
        timestamp: this.store.nowIso(),
      },
      filteredReason: this.#channelFilter(message.channelId),
    });
    return { events };
  }

  // Courses ------------------------------------------------------------------

  /**
   * Courses members can see, as `apiVisibleCourseWhere` selects them:
   * published and sold through at least one product, in sidebar order.
   */
  visibleCourses(): Array<FixtureCourse & { publishedAt: string }> {
    return this.#entities.courses
      .filter(
        (course): course is FixtureCourse & { publishedAt: string } =>
          course.publishedAt !== null && course.soldThroughProduct
      )
      .sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id)
      );
  }

  visibleCourse(courseId: string) {
    return this.visibleCourses().find((course) => course.id === courseId);
  }

  /** Every module of visible courses, in course, chapter and module order. */
  visibleModules(courseId?: string): ModuleRef[] {
    return this.visibleCourses()
      .filter((course) => !courseId || course.id === courseId)
      .flatMap((course) =>
        [...course.chapters]
          .sort((left, right) => left.position - right.position)
          .flatMap((chapter) =>
            [...chapter.modules]
              .sort((left, right) => left.position - right.position)
              .map((module) => ({
                course,
                chapterId: chapter.id,
                moduleId: module.id,
                moduleTitle: module.title,
              }))
          )
      );
  }

  /** The member's progress rows in visible courses, in module order. */
  memberProgress(
    memberId: string,
    courseId?: string
  ): CommunityModuleProgress[] {
    const rows = this.#entities.progress.filter(
      (row) => row.memberId === memberId
    );
    return this.visibleModules(courseId).flatMap((ref) => {
      const row = rows.find((item) => item.moduleId === ref.moduleId);
      return row
        ? [
            {
              memberId,
              moduleId: ref.moduleId,
              chapterId: ref.chapterId,
              courseId: ref.course.id,
              completedAt: row.completedAt,
              videoPositionSeconds: row.videoPositionSeconds,
            },
          ]
        : [];
    });
  }

  /**
   * `setApiMemberModuleProgress`: completing keeps an earlier `completedAt`;
   * uncompleting clears it and keeps the video position. Emits
   * `community.module.completed` only when the module newly completes, and
   * `community.course.completed` the first time the member completes the
   * whole course (`emitModuleCompletionEventsNow`: a marker row makes it at
   * most once per member and course).
   */
  setModuleCompletion(input: {
    member: FixtureMember;
    moduleId: string;
    completed: boolean;
  }) {
    const ref = this.visibleModules().find(
      (item) => item.moduleId === input.moduleId
    );
    if (!ref) throw new ApiError(MODULE_NOT_FOUND_ERROR, 404);

    const now = this.store.nowIso();
    let row = this.#entities.progress.find(
      (item) =>
        item.memberId === input.member.id && item.moduleId === ref.moduleId
    );
    const wasCompleted = Boolean(row?.completedAt);
    if (!row) {
      row = {
        memberId: input.member.id,
        moduleId: ref.moduleId,
        chapterId: ref.chapterId,
        courseId: ref.course.id,
        completedAt: null,
        videoPositionSeconds: 0,
      };
      this.#entities.progress.push(row);
    }
    row.completedAt = input.completed ? (row.completedAt ?? now) : null;
    this.store.changed();

    const events: DomainEvent[] = [];
    if (input.completed && !wasCompleted) {
      events.push({
        event: "community.module.completed",
        data: {
          moduleId: ref.moduleId,
          moduleTitle: ref.moduleTitle,
          chapterId: ref.chapterId,
          courseId: ref.course.id,
          courseTitle: ref.course.title,
          communityId: EMULATOR_COMMUNITY_ID,
          memberId: input.member.id,
          completedAt: row.completedAt!,
        },
        filteredReason: null,
      });
      if (
        this.#courseComplete(input.member.id, ref.course) &&
        this.#markCourseCompleted(input.member.id, ref.course.id, now)
      ) {
        events.push({
          event: "community.course.completed",
          data: {
            courseId: ref.course.id,
            courseTitle: ref.course.title,
            communityId: EMULATOR_COMMUNITY_ID,
            memberId: input.member.id,
            completedAt: row.completedAt!,
          },
          filteredReason: null,
        });
      }
    }

    return {
      progress: {
        memberId: input.member.id,
        moduleId: ref.moduleId,
        chapterId: ref.chapterId,
        courseId: ref.course.id,
        completedAt: row.completedAt,
        videoPositionSeconds: row.videoPositionSeconds,
      } satisfies CommunityModuleProgress,
      events,
    };
  }

  /** Records the completion; false when the event already went out. */
  #markCourseCompleted(
    memberId: string,
    courseId: string,
    completedAt: string
  ) {
    const completions = this.#entities.courseCompletions;
    if (
      completions.some(
        (item) => item.memberId === memberId && item.courseId === courseId
      )
    ) {
      return false;
    }
    completions.push({ memberId, courseId, completedAt });
    this.store.changed();
    return true;
  }

  #courseComplete(memberId: string, course: FixtureCourse) {
    const moduleIds = course.chapters.flatMap((chapter) =>
      chapter.modules.map((module) => module.id)
    );
    const completed = new Set(
      this.#entities.progress
        .filter((row) => row.memberId === memberId && row.completedAt)
        .map((row) => row.moduleId)
    );
    return moduleIds.length > 0 && moduleIds.every((id) => completed.has(id));
  }

  // Events -------------------------------------------------------------------

  event(eventId: string): FixtureEvent | undefined {
    return this.#entities.events.find((event) => event.id === eventId);
  }

  registrationFor(event: FixtureEvent, contactId: string | null) {
    return contactId
      ? event.registrations.find((item) => item.contactId === contactId)
      : undefined;
  }

  #registrationEvent(
    event: FixtureEvent,
    name:
      | "event.registered"
      | "event.registration_cancelled"
      | "event.attendance_classified",
    registration: EventRegistration
  ): DomainEvent {
    return {
      event: name,
      data: {
        id: registration.id,
        eventId: registration.eventId,
        contactId: registration.contactId,
        memberId: this.memberIdForContact(registration.contactId),
        attendance: registration.attendance,
      },
      filteredReason: event.showInCommunity ? null : UNFLAGGED_EVENT_REASON,
    };
  }

  /** `registerContactForEvent`: idempotent; `created` is false when already registered. */
  register(event: FixtureEvent, member: FixtureMember) {
    const contactId = this.ensureContact(member);
    const existing = this.registrationFor(event, contactId);
    if (existing) {
      return {
        registration: existing,
        created: false,
        events: [] as DomainEvent[],
      };
    }
    const registration: EventRegistration = {
      id: this.store.nextId("registration"),
      eventId: event.id,
      contactId,
      registeredAt: this.store.nowIso(),
      confirmationSentAt: null,
      attendance: "PENDING",
      joinedAt: null,
      leftAt: null,
      classifiedAt: null,
    };
    event.registrations.push(registration);
    this.store.changed();
    return {
      registration,
      created: true,
      events: [
        this.#registrationEvent(event, "event.registered", registration),
      ],
    };
  }

  /** Safe to repeat; a member without a contact was never registered. */
  cancelRegistration(event: FixtureEvent, member: FixtureMember) {
    const contactId = member.contactId;
    const existing = this.registrationFor(event, contactId);
    if (!existing) {
      return { contactId, cancelled: false, events: [] as DomainEvent[] };
    }
    event.registrations = event.registrations.filter(
      (item) => item.id !== existing.id
    );
    this.store.changed();
    return {
      contactId,
      cancelled: true,
      events: [
        this.#registrationEvent(
          event,
          "event.registration_cancelled",
          existing
        ),
      ],
    };
  }

  /** `updateEventRegistration`: emits only when `attendance` changed. */
  setAttendance(
    event: FixtureEvent,
    member: FixtureMember,
    input: {
      attendance: AttendanceStatus;
      joinedAt?: string | null;
      leftAt?: string | null;
    }
  ) {
    const registration = this.registrationFor(event, member.contactId);
    if (!registration) throw new ApiError(REGISTRATION_NOT_FOUND_ERROR, 404);
    const previous = registration.attendance;
    registration.attendance = input.attendance;
    registration.classifiedAt = this.store.nowIso();
    if (input.joinedAt !== undefined) registration.joinedAt = input.joinedAt;
    if (input.leftAt !== undefined) registration.leftAt = input.leftAt;
    this.store.changed();
    return {
      registration,
      events:
        previous === registration.attendance
          ? []
          : [
              this.#registrationEvent(
                event,
                "event.attendance_classified",
                registration
              ),
            ],
    };
  }

  // Forms --------------------------------------------------------------------

  form(formId: string): FixtureForm | undefined {
    return this.#entities.forms.find((form) => form.id === formId);
  }

  /**
   * `submitCrmForm` for a member: validates answers against the definition,
   * links the member's contact and customer, emits `form.submitted`, and
   * registers the member for SCHEDULED/LIVE events that use this form.
   */
  submitForm(input: {
    form: FixtureForm;
    member: FixtureMember;
    fields: Record<string, unknown>;
    source: FormSubmission["source"];
  }) {
    // As in `submitApiMemberForm`: the contact is linked before the answers
    // are checked.
    const contactId = this.ensureContact(input.member);
    const validated = validateFormAnswers(
      input.form.fields as FormDefinition,
      input.fields
    );
    if (!validated.ok) throw new ApiError(validated.error, 400);

    const submission: FormSubmission = {
      id: this.store.nextId("submission"),
      formId: input.form.id,
      source: input.source,
      fields: validated.answers,
      status: "NEW",
      contactId,
      customerId: input.member.customerId,
      opportunityId: null,
      createdAt: this.store.nowIso(),
    };
    input.form.submissions.push(submission);
    input.form.submissionCount = input.form.submissions.length;
    this.store.changed();

    const events: DomainEvent[] = [
      {
        event: "form.submitted",
        data: {
          id: submission.id,
          formId: submission.formId,
          contactId: submission.contactId,
          memberId: this.memberIdForContact(submission.contactId),
          source: submission.source,
        },
        filteredReason: input.form.showInCommunity
          ? null
          : UNFLAGGED_FORM_REASON,
      },
    ];
    for (const event of this.#entities.events) {
      if (
        event.formId === input.form.id &&
        (event.status === "SCHEDULED" || event.status === "LIVE")
      ) {
        events.push(...this.register(event, input.member).events);
      }
    }
    return { submission, events };
  }

  // Badges -------------------------------------------------------------------

  badge(badgeId: string): FixtureBadge | undefined {
    return this.#entities.badges.find((badge) => badge.id === badgeId);
  }

  requireBadge(badgeId: string): FixtureBadge {
    const badge = this.badge(badgeId);
    if (!badge) throw new ApiError(BADGE_NOT_FOUND_ERROR, 404);
    return badge;
  }

  /**
   * `upsertCommunityBadge`: creates the badge, or updates the one with the
   * same `key`. A new key past {@link COMMUNITY_BADGE_LIMIT_PER_APP} is a 409.
   */
  upsertBadge(input: {
    key: string;
    name: string;
    description: string;
    color: string;
  }) {
    const now = this.store.nowIso();
    const existing = this.#entities.badges.find(
      (badge) => badge.key === input.key
    );
    if (existing) {
      Object.assign(existing, {
        name: input.name,
        description: input.description,
        color: input.color,
        updatedAt: now,
      });
      this.#syncAwards(existing);
      this.store.changed();
      return { badge: existing, created: false };
    }
    if (this.#entities.badges.length >= COMMUNITY_BADGE_LIMIT_PER_APP) {
      throw new ApiError(BADGE_LIMIT_ERROR, 409);
    }
    const badge: FixtureBadge = {
      id: this.store.nextId("badge"),
      appId: this.store.app.appId,
      key: input.key,
      name: input.name,
      description: input.description,
      color: input.color,
      iconUrl: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#entities.badges.push(badge);
    this.store.changed();
    return { badge, created: true };
  }

  updateBadge(
    badge: FixtureBadge,
    patch: { name?: string; description?: string; color?: string }
  ) {
    if (patch.name !== undefined) badge.name = patch.name;
    if (patch.description !== undefined) badge.description = patch.description;
    if (patch.color !== undefined) badge.color = patch.color;
    badge.updatedAt = this.store.nowIso();
    this.#syncAwards(badge);
    this.store.changed();
    return badge;
  }

  /** Deletes the badge and every award of it; sends no events. */
  deleteBadge(badge: FixtureBadge) {
    this.#entities.badges = this.#entities.badges.filter(
      (item) => item.id !== badge.id
    );
    for (const member of this.#entities.members) {
      member.badges = member.badges.filter((award) => award.id !== badge.id);
    }
    this.store.changed();
  }

  /** Safe to repeat: an existing award keeps `awardedAt` and sends no event. */
  awardBadge(member: FixtureMember, badge: FixtureBadge) {
    const existing = member.badges.find((award) => award.id === badge.id);
    if (existing) return { award: existing, events: [] as DomainEvent[] };
    const award = toMemberBadge(badge, this.store.nowIso());
    member.badges.push(award);
    this.store.changed();
    return {
      award,
      events: [this.#badgeEvent("community.badge.awarded", badge, member)],
    };
  }

  revokeBadge(member: FixtureMember, badge: FixtureBadge) {
    const had = member.badges.some((award) => award.id === badge.id);
    if (!had) return { revoked: false, events: [] as DomainEvent[] };
    member.badges = member.badges.filter((award) => award.id !== badge.id);
    this.store.changed();
    return {
      revoked: true,
      events: [this.#badgeEvent("community.badge.revoked", badge, member)],
    };
  }

  badgeEventData(
    badge: Pick<FixtureBadge, "id" | "key" | "appId">,
    memberId: string
  ) {
    return {
      badgeId: badge.id,
      badgeKey: badge.key,
      appId: badge.appId,
      memberId,
      timestamp: this.store.nowIso(),
    };
  }

  #badgeEvent(
    event: "community.badge.awarded" | "community.badge.revoked",
    badge: FixtureBadge,
    member: FixtureMember
  ): DomainEvent {
    return {
      event,
      data: this.badgeEventData(badge, member.id),
      filteredReason: null,
    };
  }

  // Notifications ----------------------------------------------------------

  /**
   * `POST /community/notifications` after validation. Ids are deduped in
   * request order, then each member is checked in production's order:
   * `member_not_found`, `member_not_active`, a `key` already sent to the
   * member in the last 24 hours (reported accepted; nothing is stored and
   * the cap isn't used), `over_limit` at
   * {@link COMMUNITY_NOTIFICATION_HOURLY_LIMIT} in a rolling hour, otherwise
   * accepted and stored with the app's name as title. `channel_not_visible`
   * never happens: the emulator's APP channel is always visible. Times come
   * from the store clock.
   */
  sendNotifications(input: {
    memberIds: string[];
    body: string;
    path: string;
    key: string | null;
  }): CommunityNotificationSendResult {
    const now = this.store.now().getTime();
    const createdAt = new Date(now).toISOString();
    const entities = this.#entities;
    const keptSends = entities.notificationSends.filter(
      (send) => now - Date.parse(send.at) < COMMUNITY_NOTIFICATION_KEY_WINDOW_MS
    );
    let changed = keptSends.length !== entities.notificationSends.length;
    entities.notificationSends = keptSends;

    const result: CommunityNotificationSendResult = {
      accepted: [],
      skipped: [],
    };
    for (const memberId of new Set(input.memberIds)) {
      const member = this.member(memberId);
      if (!member) {
        result.skipped.push({ memberId, reason: "member_not_found" });
        continue;
      }
      if (member.status !== "ACTIVE") {
        result.skipped.push({ memberId, reason: "member_not_active" });
        continue;
      }
      const sends = entities.notificationSends.filter(
        (send) => send.memberId === member.id
      );
      if (input.key !== null && sends.some((send) => send.key === input.key)) {
        result.accepted.push(member.id);
        continue;
      }
      const lastHour = sends.filter(
        (send) =>
          now - Date.parse(send.at) < COMMUNITY_NOTIFICATION_LIMIT_WINDOW_MS
      );
      if (lastHour.length >= COMMUNITY_NOTIFICATION_HOURLY_LIMIT) {
        result.skipped.push({ memberId, reason: "over_limit" });
        continue;
      }
      entities.notificationSends.push({
        memberId: member.id,
        key: input.key,
        at: createdAt,
      });
      entities.notifications.push({
        id: this.store.nextId("notification"),
        memberId: member.id,
        title: this.store.app.name,
        body: input.body,
        path: input.path,
        href: communityAppChannelHref(this.store.app.channelId, input.path),
        createdAt,
      } satisfies FixtureNotification);
      result.accepted.push(member.id);
      changed = true;
    }
    if (changed) this.store.changed();
    return result;
  }

  /** Awards snapshot the badge; keep them in step after an edit. */
  #syncAwards(badge: FixtureBadge) {
    for (const member of this.#entities.members) {
      member.badges = member.badges.map((award) =>
        award.id === badge.id ? toMemberBadge(badge, award.awardedAt) : award
      );
    }
  }
}
