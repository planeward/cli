/**
 * Error with an HTTP status, answered as `{ error }` (or `body` when set),
 * like Planeward's `ApiError` / `CommunityApiError`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body ?? { error: message };
  }
}

export const MEMBER_NOT_FOUND_ERROR = "Member not found.";
export const MEMBER_NOT_ACTIVE_ERROR = "Member is not active.";
export const MEMBER_NO_PRIMARY_CONTACT_ERROR = "Member has no primary contact.";
export const INVALID_JSON_BODY_ERROR = "Invalid JSON body.";
export const APP_MEMBER_ID_REQUIRED_ERROR =
  "Community apps must identify the member with memberId.";
export const CHANNEL_NOT_FOUND_ERROR = "Channel not found.";
export const APP_CHANNEL_FORBIDDEN_ERROR =
  "This app can't post in that channel.";
export const COURSE_NOT_FOUND_ERROR = "Course not found.";
export const MODULE_NOT_FOUND_ERROR = "Module not found.";
export const EVENT_NOT_FOUND_ERROR = "Event not found.";
export const EVENT_NOT_IN_COMMUNITY_ERROR = "Event not shown in community.";
export const REGISTRATION_NOT_FOUND_ERROR = "Registration not found.";
export const FORM_NOT_FOUND_ERROR = "Form not found.";
export const FORM_NOT_PUBLISHED_ERROR = "Form is not published.";
export const FORM_NOT_IN_COMMUNITY_ERROR = "Form not shown in community.";
export const BADGE_NOT_FOUND_ERROR = "Badge not found.";
export const MESSAGE_NOT_FOUND_ERROR = "Message not found.";
export const INVALID_CURSOR_ERROR = "Invalid cursor.";
export const API_KEY_ERROR = "Invalid or missing API key";
export const APP_AUTH_ERROR = "Invalid or missing app credentials";
export const INSUFFICIENT_SCOPE_ERROR = "Insufficient API key permissions";
