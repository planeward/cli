import type { ActivityAction, FixtureMember } from "../contract";
import { type Domain, type DomainEvent } from "./domain";
import {
  ApiError,
  EVENT_NOT_FOUND_ERROR,
  FORM_NOT_FOUND_ERROR,
} from "./errors";

/**
 * Applies an Activity panel action as the member (or staff, for membership
 * changes) would in Planeward, and returns the webhook events it produced.
 * Members act with their own rights: they can post where they can see, and
 * RSVP / submit unflagged events and forms (apps just don't hear about it).
 */
export function applyActivity(
  domain: Domain,
  action: ActivityAction
): DomainEvent[] {
  const activeMember = (memberId: string): FixtureMember =>
    domain.requireMember(memberId, { requireActive: true });

  switch (action.type) {
    case "message.post": {
      const member = activeMember(action.memberId);
      const body = action.body.trim();
      if (!body) throw new ApiError("Message cannot be empty.", 400);
      if (body.length > 4000) throw new ApiError("Message is too long.", 400);
      return domain.postMessage({
        channelId: action.channelId,
        body,
        replyToId: action.replyToId?.trim() || null,
        author: {
          kind: "member",
          memberId: member.id,
          installationId: null,
          name: member.displayName,
        },
      }).events;
    }
    case "message.delete":
      return domain.deleteMessage(action.messageId).events;
    case "reaction.add":
    case "reaction.remove":
      return domain.setReaction({
        member: activeMember(action.memberId),
        messageId: action.messageId,
        emoji: action.emoji,
        present: action.type === "reaction.add",
      }).events;
    case "module.complete":
    case "module.uncomplete":
      return domain.setModuleCompletion({
        member: activeMember(action.memberId),
        moduleId: action.moduleId,
        completed: action.type === "module.complete",
      }).events;
    case "event.rsvp":
    case "event.cancel_rsvp":
    case "event.attendance": {
      const member = activeMember(action.memberId);
      const event = domain.event(action.eventId);
      if (!event) throw new ApiError(EVENT_NOT_FOUND_ERROR, 404);
      if (action.type === "event.rsvp") {
        return domain.register(event, member).events;
      }
      if (action.type === "event.cancel_rsvp") {
        return domain.cancelRegistration(event, member).events;
      }
      return domain.setAttendance(event, member, {
        attendance: action.attendance,
      }).events;
    }
    case "form.submit": {
      const member = activeMember(action.memberId);
      const form = domain.form(action.formId);
      if (!form) throw new ApiError(FORM_NOT_FOUND_ERROR, 404);
      if (form.status !== "PUBLISHED") {
        throw new ApiError("Form is not published.", 404);
      }
      return domain.submitForm({
        form,
        member,
        fields: action.fields,
        source: "HOST",
      }).events;
    }
    case "membership.grant":
      return domain.grantMembership(action).events;
    case "membership.suspend":
    case "membership.resume":
    case "membership.revoke": {
      const member = domain.requireMember(action.memberId, {
        requireActive: false,
      });
      const verb = action.type.slice("membership.".length) as
        "suspend" | "resume" | "revoke";
      return domain.setMembershipStatus(member, verb).events;
    }
    default: {
      const unknown: never = action;
      throw new ApiError(
        `Unknown activity "${(unknown as { type?: string }).type}".`,
        400
      );
    }
  }
}
