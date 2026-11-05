/**
 * v1 API response shapes, field for field as Planeward serializes them for an
 * app caller (`server/api/v1/*`, `server/crm/*`).
 */
import type {
  CommunityBadge,
  CommunityChannel,
  CommunityCourse,
  CommunityCourseSummary,
  CommunityMember,
  CommunityMemberBadge,
  CommunityMessage,
  CommunityReactionCount,
  EventRegistration,
  FixtureBadge,
  FixtureChannel,
  FixtureCourse,
  FixtureEvent,
  FixtureForm,
  FixtureMember,
  FixtureMessage,
  FormSubmission,
} from "../contract";
import { CHANNEL_CATEGORY_ORDER, DEFAULT_FORM_SETTINGS } from "./fixtures";

export function toApiMember(member: FixtureMember): CommunityMember {
  return {
    id: member.id,
    customerId: member.customerId,
    username: member.username,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    status: member.status,
    accessPlans: member.accessPlans,
    roles: member.roles,
    // Newest award first.
    badges: [...member.badges].sort(
      (left, right) =>
        right.awardedAt.localeCompare(left.awardedAt) ||
        right.id.localeCompare(left.id)
    ),
    joinedAt: member.joinedAt,
  };
}

/** Sidebar order: uncategorized first, then categories in order, then position and name. */
export function sortChannels(channels: FixtureChannel[]): FixtureChannel[] {
  const rank = (channel: FixtureChannel) =>
    channel.categoryId === null
      ? -1
      : (CHANNEL_CATEGORY_ORDER as readonly string[]).indexOf(
          channel.categoryId
        );
  return [...channels].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.position - right.position ||
      left.name.localeCompare(right.name)
  );
}

export function toApiChannel(channel: FixtureChannel): CommunityChannel {
  return {
    id: channel.id,
    name: channel.name,
    slug: channel.slug,
    description: channel.description,
    kind: channel.kind,
    categoryId: channel.categoryId,
    position: channel.position,
  };
}

/** One entry per emoji, most used first (ties by emoji). */
export function reactionCounts(
  message: Pick<FixtureMessage, "reactions">
): CommunityReactionCount[] {
  const byEmoji = new Map<string, number>();
  for (const reaction of message.reactions) {
    byEmoji.set(reaction.emoji, (byEmoji.get(reaction.emoji) ?? 0) + 1);
  }
  return [...byEmoji.entries()]
    .sort(
      ([leftEmoji, leftCount], [rightEmoji, rightCount]) =>
        rightCount - leftCount || leftEmoji.localeCompare(rightEmoji)
    )
    .map(([emoji, count]) => ({ emoji, count }));
}

export function toApiMessage(message: FixtureMessage): CommunityMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    body: message.body,
    replyToId: message.replyToId,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    author: message.author,
    reactions: reactionCounts(message),
  };
}

/** Chapters without modules are left out, as members see them. */
function visibleChapters(course: FixtureCourse) {
  return course.chapters.filter((chapter) => chapter.modules.length > 0);
}

export function toApiCourseSummary(
  course: FixtureCourse & { publishedAt: string }
): CommunityCourseSummary {
  const chapters = visibleChapters(course);
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    position: course.position,
    chapterCount: chapters.length,
    moduleCount: chapters.reduce(
      (sum, chapter) => sum + chapter.modules.length,
      0
    ),
    publishedAt: course.publishedAt,
  };
}

export function toApiCourse(
  course: FixtureCourse & { publishedAt: string }
): CommunityCourse {
  return {
    ...toApiCourseSummary(course),
    chapters: visibleChapters(course).map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      position: chapter.position,
      modules: [...chapter.modules]
        .sort(
          (left, right) =>
            left.position - right.position ||
            left.title.localeCompare(right.title)
        )
        .map((module) => ({
          id: module.id,
          title: module.title,
          description: module.description,
          durationSeconds: module.durationSeconds,
          position: module.position,
        })),
    })),
  };
}

/**
 * `eventForCaller` for an app: no CRM pipeline (`pipeline`, `pipelineId`),
 * and `form` / `formId` only for a published form shown in community, so a
 * hidden form looks like none.
 */
function eventBase(event: FixtureEvent, forms: FixtureForm[]) {
  const linked = event.formId
    ? forms.find((item) => item.id === event.formId)
    : undefined;
  const form =
    linked && linked.status === "PUBLISHED" && linked.showInCommunity
      ? linked
      : undefined;
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    name: event.name,
    slug: event.slug,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    offerStartsAt: event.offerStartsAt,
    status: event.status,
    formId: form ? form.id : null,
    showInCommunity: event.showInCommunity,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    form: form ? { id: form.id, name: form.name } : null,
  };
}

/** `GET /events` row: includes `_count.registrations` like `listEvents`. */
export function toApiEventListItem(event: FixtureEvent, forms: FixtureForm[]) {
  return {
    ...eventBase(event, forms),
    _count: { registrations: event.registrations.length },
  };
}

/** `GET /events/{id}`: includes `counts` by attendance like `getEvent`. */
export function toApiEvent(event: FixtureEvent, forms: FixtureForm[]) {
  const counts = {
    registered: event.registrations.length,
    PENDING: 0,
    ATTENDED: 0,
    LEFT_EARLY: 0,
    NO_SHOW: 0,
    UNCLASSIFIED: 0,
  };
  for (const registration of event.registrations) {
    counts[registration.attendance] += 1;
  }
  return { ...eventBase(event, forms), counts };
}

/** `registrationForCaller`: apps get no expanded `contact` and no `opportunityId`. */
export function toApiRegistration(
  registration: EventRegistration,
  workspaceId: string
) {
  return {
    id: registration.id,
    workspaceId,
    eventId: registration.eventId,
    contactId: registration.contactId,
    registeredAt: registration.registeredAt,
    confirmationSentAt: registration.confirmationSentAt,
    attendance: registration.attendance,
    joinedAt: registration.joinedAt,
    leftAt: registration.leftAt,
    classifiedAt: registration.classifiedAt,
  };
}

/**
 * `serializeCommunityForm`: the field definition, the real submission count,
 * and from `settings` only what rendering needs (`respondent`, `theme`,
 * `css`). CRM routing, `embed` and `publicLink` are left out.
 */
export function toApiCommunityForm(form: FixtureForm) {
  const { respondent, theme, css } = {
    ...DEFAULT_FORM_SETTINGS,
    ...form.settings,
  };
  return {
    id: form.id,
    workspaceId: form.workspaceId,
    name: form.name,
    slug: form.slug,
    publicSlug: form.publicSlug,
    status: form.status,
    description: form.description,
    showInCommunity: form.showInCommunity,
    fields: form.fields,
    settings: { respondent, theme, css },
    submissionCount: form.submissions.length,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
  };
}

export function toApiSubmission(submission: FormSubmission): FormSubmission {
  return {
    id: submission.id,
    formId: submission.formId,
    source: submission.source,
    fields: submission.fields,
    status: submission.status,
    contactId: submission.contactId,
    customerId: submission.customerId,
    opportunityId: submission.opportunityId,
    createdAt: submission.createdAt,
  };
}

export function toApiBadge(badge: FixtureBadge): CommunityBadge {
  return {
    id: badge.id,
    appId: badge.appId,
    key: badge.key,
    name: badge.name,
    description: badge.description,
    color: badge.color,
    iconUrl: badge.iconUrl,
    createdAt: badge.createdAt,
    updatedAt: badge.updatedAt,
  };
}

export function toMemberBadge(
  badge: FixtureBadge,
  awardedAt: string
): CommunityMemberBadge {
  return {
    id: badge.id,
    appId: badge.appId,
    key: badge.key,
    name: badge.name,
    description: badge.description,
    color: badge.color,
    iconUrl: badge.iconUrl,
    awardedAt,
  };
}
