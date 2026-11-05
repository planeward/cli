/**
 * Contract between the emulator UI (React SPA served by the emulator) and the
 * emulator server. Every route lives under `/__emulator/*` on
 * `http://127.0.0.1:4600`; the mock Planeward API (`/api/v1/*`) and JWKS
 * (`/api/auth/jwks`) share the same origin.
 *
 * Bodies are JSON. Successful responses are `{ data }`; failures are
 * `{ error }` with a 4xx/5xx status.
 *
 * The API entity shapes below mirror `apps/docs/openapi/v1.yaml` in the
 * Planeward repo (same names as its `components/schemas`). Once
 * `@planeward/sdk` exports the generated OpenAPI types, replace them with
 * those imports.
 */
import type {
  AppContext,
  AppTheme,
  AppView,
  AppViewerRole,
} from "@planeward/sdk";
import type { AppWebhookEnvelope } from "@planeward/sdk/server";

import type { AppGrantableScope } from "../manifest";

// Server --------------------------------------------------------------------

export const EMULATOR_HOST = "127.0.0.1";

export const EMULATOR_DEFAULT_PORT = 4600;

export const EMULATOR_DEFAULT_ORIGIN = `http://${EMULATOR_HOST}:${EMULATOR_DEFAULT_PORT}`;

export const EMULATOR_BASE_PATH = "/__emulator";

/** Local workspace and installation ids the emulator always uses. */
export const EMULATOR_WORKSPACE_ID = "workspace_local";
export const EMULATOR_INSTALLATION_ID = "installation_local";

/**
 * Route patterns (Hono syntax: `:param`). Use `emulatorPath` to fill params
 * on the client.
 */
export const EMULATOR_ROUTES = {
  /** GET → `EmulatorStateResponse`. */
  state: `${EMULATOR_BASE_PATH}/state`,
  /** PUT `SetViewerRequest` → `EmulatorStateResponse`. */
  viewer: `${EMULATOR_BASE_PATH}/viewer`,
  /** PUT `SetViewRequest` → `EmulatorStateResponse`. */
  view: `${EMULATOR_BASE_PATH}/view`,
  /** PUT `SetThemeRequest` → `EmulatorStateResponse`. */
  theme: `${EMULATOR_BASE_PATH}/theme`,
  /** POST `MintViewerTokenRequest` → `MintViewerTokenResponse`. */
  token: `${EMULATOR_BASE_PATH}/token`,
  /** GET `?after=<id>` → `ApiRequestLogResponse`. */
  requests: `${EMULATOR_BASE_PATH}/requests`,
  /** GET `?after=<id>` → `WebhookDeliveryListResponse`. */
  deliveries: `${EMULATOR_BASE_PATH}/deliveries`,
  /** POST (no body) → `WebhookDeliveryResponse` (the new attempt). */
  redeliver: `${EMULATOR_BASE_PATH}/deliveries/:deliveryId/redeliver`,
  /** POST `ActivityAction` → `ActivityResponse`. */
  activity: `${EMULATOR_BASE_PATH}/activity`,
  /** POST (no body) → `EmulatorStateResponse`. Reseeds the store. */
  reset: `${EMULATOR_BASE_PATH}/reset`,
  /** GET → `text/event-stream` of `EmulatorStreamEvent`. */
  stream: `${EMULATOR_BASE_PATH}/stream`,
  /**
   * POST `TriggerRequest` → `WebhookDeliveryResponse` once the delivery has
   * finished (or was skipped). `planeward trigger` calls it.
   */
  trigger: `${EMULATOR_BASE_PATH}/trigger`,
} as const;

export type EmulatorRoute =
  (typeof EMULATOR_ROUTES)[keyof typeof EMULATOR_ROUTES];

/** Fills `:param` segments, e.g. `emulatorPath(EMULATOR_ROUTES.redeliver, { deliveryId })`. */
export function emulatorPath(
  route: EmulatorRoute,
  params: Record<string, string> = {}
): string {
  return route.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing route param "${name}" for ${route}`);
    }
    return encodeURIComponent(value);
  });
}

export type EmulatorErrorResponse = { error: string };

// API entities (mirror v1.yaml components/schemas) -----------------------------

export type CommunityMemberStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export type CommunityNamedRef = { id: string; name: string };

/** `CommunityMemberBadge`. */
export type CommunityMemberBadge = {
  /** Badge id. */
  id: string;
  appId: string;
  key: string;
  name: string;
  description: string;
  color: string;
  iconUrl: string | null;
  awardedAt: string;
};

/** `CommunityMember`. */
export type CommunityMember = {
  /** Community membership id (`memberId` everywhere else). */
  id: string;
  customerId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: CommunityMemberStatus;
  accessPlans: CommunityNamedRef[];
  roles: CommunityNamedRef[];
  badges: CommunityMemberBadge[];
  joinedAt: string;
};

/** `CommunityChannel`. */
export type CommunityChannel = {
  id: string;
  name: string;
  slug: string;
  description: string;
  kind: "TEXT" | "APP";
  categoryId: string | null;
  position: number;
};

/** `CommunityReactionCount`. */
export type CommunityReactionCount = { emoji: string; count: number };

/** `CommunityMessageAuthor`. */
export type CommunityMessageAuthor = {
  kind: "member" | "staff" | "app";
  memberId: string | null;
  installationId: string | null;
  name: string;
};

/** `CommunityMessage`. */
export type CommunityMessage = {
  id: string;
  channelId: string;
  body: string;
  replyToId: string | null;
  createdAt: string;
  editedAt: string | null;
  author: CommunityMessageAuthor;
  reactions: CommunityReactionCount[];
};

/** `CommunityModuleOutline`. */
export type CommunityModuleOutline = {
  id: string;
  title: string;
  description: string;
  durationSeconds: number;
  position: number;
};

/** `CommunityChapter`. */
export type CommunityChapter = {
  id: string;
  title: string;
  position: number;
  modules: CommunityModuleOutline[];
};

/** `CommunityCourseSummary`. */
export type CommunityCourseSummary = {
  id: string;
  title: string;
  description: string;
  position: number;
  chapterCount: number;
  moduleCount: number;
  publishedAt: string;
};

/** `CommunityCourse`. */
export type CommunityCourse = CommunityCourseSummary & {
  chapters: CommunityChapter[];
};

/** `CommunityModuleProgress`. */
export type CommunityModuleProgress = {
  memberId: string;
  moduleId: string;
  chapterId: string;
  courseId: string;
  completedAt: string | null;
  videoPositionSeconds: number;
};

/** `CommunityBadge`. */
export type CommunityBadge = {
  id: string;
  appId: string;
  key: string;
  name: string;
  description: string;
  color: string;
  iconUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `AttendanceStatus`. */
export type AttendanceStatus =
  "PENDING" | "ATTENDED" | "LEFT_EARLY" | "NO_SHOW" | "UNCLASSIFIED";

/**
 * `Event` as apps get it (without the get-only `counts`): no CRM pipeline
 * (`pipelineId`, `pipeline`).
 */
export type Event = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  offerStartsAt: string | null;
  status: "SCHEDULED" | "LIVE" | "ENDED" | "CANCELLED";
  formId: string | null;
  showInCommunity: boolean;
  createdAt: string;
  updatedAt: string;
};

/** `EventRegistration` as apps get it: no expanded `contact`, no `opportunityId`. */
export type EventRegistration = {
  id: string;
  eventId: string;
  contactId: string;
  registeredAt: string;
  confirmationSentAt: string | null;
  attendance: AttendanceStatus;
  joinedAt: string | null;
  leftAt: string | null;
  classifiedAt: string | null;
};

/** `Form`. */
export type Form = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  publicSlug: string;
  status: "DRAFT" | "PUBLISHED";
  description: string;
  fields: Record<string, unknown>;
  settings: Record<string, unknown>;
  showInCommunity: boolean;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
};

/** `FormSubmission`. */
export type FormSubmission = {
  id: string;
  formId: string;
  source: "HOST" | "SITE" | "EMBED";
  fields: Record<string, unknown>;
  status: "NEW" | "SPAM";
  contactId: string | null;
  customerId: string | null;
  opportunityId: string | null;
  createdAt: string;
};

// Fixtures (emulator store) ---------------------------------------------------

/** A seeded member plus the private fields the mock API resolves through. */
export type FixtureMember = CommunityMember & {
  email: string;
  /** Null until an RSVP or form submission auto-creates one. */
  contactId: string | null;
  /**
   * The member's CRM customer has no email but already has contacts, none
   * of them primary, so no contact can be picked or created: an RSVP or form
   * submission answers 409 "Member has no primary contact.".
   */
  contactConflict: boolean;
};

/** `@everyone` rights after overwrites; a channel `@everyone` can't view is private. */
export type FixtureChannel = CommunityChannel & {
  everyone: { view: boolean; send: boolean };
};

export type FixtureReaction = { emoji: string; memberId: string };

/** Stored message: per-member reactions; the API derives counts. */
export type FixtureMessage = Omit<CommunityMessage, "reactions"> & {
  reactions: FixtureReaction[];
  deletedAt: string | null;
};

/**
 * Courses are stored with their outline. The API shows only courses that are
 * published and sold through at least one product (`soldThroughProduct`).
 */
export type FixtureCourse = Omit<CommunityCourse, "publishedAt"> & {
  publishedAt: string | null;
  soldThroughProduct: boolean;
};

/** Marks a sent `community.course.completed`; it goes out once per member and course. */
export type FixtureCourseCompletion = {
  memberId: string;
  courseId: string;
  completedAt: string;
};

export type FixtureEvent = Event & { registrations: EventRegistration[] };

export type FixtureForm = Form & { submissions: FormSubmission[] };

/** Badges the app created through the mock API; awards live on `FixtureMember.badges`. */
export type FixtureBadge = CommunityBadge;

export type EmulatorEntities = {
  members: FixtureMember[];
  channels: FixtureChannel[];
  messages: FixtureMessage[];
  courses: FixtureCourse[];
  progress: CommunityModuleProgress[];
  courseCompletions: FixtureCourseCompletion[];
  events: FixtureEvent[];
  forms: FixtureForm[];
  badges: FixtureBadge[];
};

// State ---------------------------------------------------------------------

export type EmulatorViewer = {
  memberId: string;
  role: AppViewerRole;
};

export type EmulatorApp = {
  name: string;
  slug: string;
  /** `<slug>-local`; the viewer token's `aud`. */
  appId: string;
  installationId: string;
  workspaceId: string;
  /** The APP channel the Experience view renders in. */
  channelId: string;
  scopes: AppGrantableScope[];
  /** `dev.url + experiencePath`. */
  experienceUrl: string;
  /** `dev.url + dashboardPath`, or null without one. */
  dashboardUrl: string | null;
  /** `dev.url + webhookPath`, or null without one. */
  webhookUrl: string | null;
  /** The manifest's `dev` block; the host UI shows it when the app isn't running. */
  dev: { command: string; url: string };
};

export type EmulatorState = {
  app: EmulatorApp;
  viewer: EmulatorViewer;
  view: AppView;
  theme: AppTheme;
  entities: EmulatorEntities;
};

export type EmulatorStateResponse = { data: EmulatorState };

export type SetViewerRequest = EmulatorViewer;

export type SetViewRequest = { view: AppView };

export type SetThemeRequest = { theme: AppTheme };

// Viewer token ----------------------------------------------------------------

/** Mints a token for the current viewer and view (same claims as production). */
export type MintViewerTokenRequest = Record<string, never>;

export type MintViewerToken = {
  token: string;
  /** Milliseconds since epoch, like `AppTokenMessage.expiresAt`. */
  expiresAt: number;
  context: AppContext;
};

export type MintViewerTokenResponse = { data: MintViewerToken };

// Requests log ----------------------------------------------------------------

export type ApiRequestLogEntry = {
  id: string;
  /** ISO 8601. */
  at: string;
  method: string;
  /** Path without the query string, e.g. `/api/v1/events`. */
  path: string;
  /** Raw query string without `?`; empty when none. */
  query: string;
  /** Matched route pattern, e.g. `/api/v1/events/:eventId`; null on 404. */
  route: string | null;
  status: number;
  durationMs: number;
  /** Scope the route requires; null for unauthenticated routes and 404s. */
  scope: AppGrantableScope | null;
  /** Set on a 403 for a missing scope (same as the response's `missingScope`). */
  missingScope: AppGrantableScope | null;
  requestBody: unknown;
  responseBody: unknown;
};

export type ApiRequestLogResponse = { data: ApiRequestLogEntry[] };

// Webhook deliveries ----------------------------------------------------------

/** App-relevant webhook events the emulator can send. */
export const EMULATOR_WEBHOOK_EVENTS = [
  "app.installed",
  "app.uninstalled",
  "community.membership.granted",
  "community.membership.suspended",
  "community.membership.resumed",
  "community.membership.revoked",
  "community.message.created",
  "community.message.deleted",
  "community.reaction.added",
  "community.reaction.removed",
  "community.module.completed",
  "community.course.completed",
  "event.registered",
  "event.registration_cancelled",
  "event.attendance_classified",
  "form.submitted",
  "community.badge.awarded",
  "community.badge.revoked",
] as const;

export type EmulatorWebhookEventName = (typeof EMULATOR_WEBHOOK_EVENTS)[number];

export type WebhookDeliveryStatus =
  "pending" | "succeeded" | "failed" | "skipped";

export type WebhookDeliveryEntry = {
  /**
   * Emulator log id, unique per send: a redelivery is a new entry with a new
   * `id`. The stream re-sends an entry when its status changes; upsert by `id`.
   */
  id: string;
  /**
   * `x-planeward-delivery`. Like production, a redelivery keeps the original
   * delivery's id so apps can dedupe on it.
   */
  deliveryId: string;
  /** Set on a redelivery: the entry (`id`) it repeats. */
  redeliveryOf: string | null;
  event: EmulatorWebhookEventName;
  /** Null when the manifest has no `webhookPath`. */
  url: string | null;
  status: WebhookDeliveryStatus;
  /** Why it was skipped: no webhook URL, or the scope the event needs is not granted. */
  skippedReason: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  /** ISO 8601. */
  createdAt: string;
  envelope: AppWebhookEnvelope;
  /** Truncated response body from the app. */
  responseBody: string | null;
};

export type WebhookDeliveryListResponse = { data: WebhookDeliveryEntry[] };

export type WebhookDeliveryResponse = { data: WebhookDeliveryEntry };

/** Sends one event built from the current state (`EMULATOR_ROUTES.trigger`). */
export type TriggerRequest = {
  event: EmulatorWebhookEventName;
  /** Member the event is about; defaults to the current viewer. */
  memberId?: string;
};

// Activity ------------------------------------------------------------------

/** Act as a member (or staff, for membership changes); updates the store and fires webhooks. */
export type ActivityAction =
  | {
      type: "message.post";
      memberId: string;
      channelId: string;
      body: string;
      replyToId?: string;
    }
  | { type: "message.delete"; messageId: string }
  | { type: "reaction.add"; memberId: string; messageId: string; emoji: string }
  | {
      type: "reaction.remove";
      memberId: string;
      messageId: string;
      emoji: string;
    }
  | { type: "module.complete"; memberId: string; moduleId: string }
  | { type: "module.uncomplete"; memberId: string; moduleId: string }
  | { type: "event.rsvp"; memberId: string; eventId: string }
  | { type: "event.cancel_rsvp"; memberId: string; eventId: string }
  | {
      type: "event.attendance";
      memberId: string;
      eventId: string;
      attendance: AttendanceStatus;
    }
  | {
      type: "form.submit";
      memberId: string;
      formId: string;
      fields: Record<string, unknown>;
    }
  /** Creates a new ACTIVE member. */
  | { type: "membership.grant"; displayName: string; email: string }
  | { type: "membership.suspend"; memberId: string }
  | { type: "membership.resume"; memberId: string }
  | { type: "membership.revoke"; memberId: string };

export type ActivityActionType = ActivityAction["type"];

export type ActivityResult = {
  /** Webhook events the action produced, in order (empty when nothing changed). */
  events: EmulatorWebhookEventName[];
  /** Deliveries queued for those events (skipped ones included). */
  deliveryIds: string[];
  state: EmulatorState;
};

export type ActivityResponse = { data: ActivityResult };

// Stream ----------------------------------------------------------------------

/**
 * Server-sent events on `EMULATOR_ROUTES.stream`. The SSE `event:` field is
 * the `type`; `data:` is the JSON of the whole object.
 */
export type EmulatorStreamEvent =
  | { type: "request"; entry: ApiRequestLogEntry }
  | { type: "delivery"; entry: WebhookDeliveryEntry }
  | { type: "state"; state: EmulatorState };

export type EmulatorStreamEventType = EmulatorStreamEvent["type"];
