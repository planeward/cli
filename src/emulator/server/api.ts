/**
 * Mock Planeward v1 API for app callers: every app-grantable endpoint, with
 * the same auth, scope checks, visibility rules, statuses and messages as
 * production (`apps/web/src/app/api/v1/**`, `server/api/v1/*`).
 */
import { timingSafeEqual } from "node:crypto";
import { APP_INSTALLATION_HEADER } from "@planeward/sdk/server";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import type { AppGrantableScope } from "../../manifest";
import type { FixtureEvent, FixtureMember } from "../contract";
import type { Domain } from "./domain";
import {
  COMMUNITY_BADGE_DESCRIPTION_MAX_LENGTH,
  COMMUNITY_BADGE_KEY_MAX_LENGTH,
  COMMUNITY_BADGE_NAME_MAX_LENGTH,
} from "./domain";
import {
  API_KEY_ERROR,
  ApiError,
  APP_AUTH_ERROR,
  APP_CHANNEL_FORBIDDEN_ERROR,
  APP_MEMBER_ID_REQUIRED_ERROR,
  CHANNEL_NOT_FOUND_ERROR,
  COURSE_NOT_FOUND_ERROR,
  EVENT_NOT_FOUND_ERROR,
  EVENT_NOT_IN_COMMUNITY_ERROR,
  FORM_NOT_FOUND_ERROR,
  FORM_NOT_IN_COMMUNITY_ERROR,
  FORM_NOT_PUBLISHED_ERROR,
  INSUFFICIENT_SCOPE_ERROR,
  INVALID_CURSOR_ERROR,
  INVALID_JSON_BODY_ERROR,
  MEMBER_NOT_ACTIVE_ERROR,
  MEMBER_NOT_FOUND_ERROR,
} from "./errors";
import type { RequestLog } from "./requests";
import { checkScopes, type ScopeRequirement } from "./scopes";
import {
  sortChannels,
  toApiBadge,
  toApiChannel,
  toApiCommunityForm,
  toApiCourse,
  toApiCourseSummary,
  toApiEvent,
  toApiEventListItem,
  toApiMember,
  toApiMessage,
  toApiRegistration,
  toApiSubmission,
} from "./serialize";
import type { EmulatorStore } from "./store";
import type { WebhookDispatcher } from "./webhooks";

export const API_PREFIX = "/api/v1";

type ApiEnv = {
  Variables: {
    route: string | null;
    scope: AppGrantableScope | null;
    missingScope: AppGrantableScope | null;
    /** Set once auth passed and the body is within the limit; only then is it logged. */
    logBody: boolean;
  };
};

type ApiContext = Context<ApiEnv>;

export type ApiDeps = {
  store: EmulatorStore;
  domain: Domain;
  webhooks: WebhookDispatcher;
  requests: RequestLog;
  appSecret: string;
  /** `dev.url`'s origin; gets CORS on `/api/v1/*`. */
  appOrigin: string | null;
};

// Request schemas, as in production ------------------------------------------

const APP_MESSAGE_BODY_MAX_LENGTH = 4000;

const appMessageInputSchema = z.object({
  body: z.string().trim().min(1).max(APP_MESSAGE_BODY_MAX_LENGTH),
  replyToId: z.string().trim().min(1).optional(),
});

const ATTENDANCE_STATUSES = [
  "PENDING",
  "ATTENDED",
  "LEFT_EARLY",
  "NO_SHOW",
  "UNCLASSIFIED",
] as const;

const dateTime = z.iso.datetime({ offset: true });

const eventRegisterSchema = z.strictObject({
  memberId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
});

const eventCancelQuerySchema = z.object({
  memberId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
});

const eventAttendanceSetForRefSchema = z.object({
  attendance: z.enum(ATTENDANCE_STATUSES),
  joinedAt: dateTime.nullable().optional(),
  leftAt: dateTime.nullable().optional(),
  memberId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
});

const memberFormSubmissionSchema = z.object({
  memberId: z.string().trim().min(1),
  fields: z.record(z.string(), z.unknown()),
});

// `server/community/badges.ts`.
const badgeColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex color like #7c3aed.")
  .transform((value) => value.toLowerCase());
const badgeName = z
  .string()
  .trim()
  .min(1, "name is required.")
  .max(COMMUNITY_BADGE_NAME_MAX_LENGTH);
const badgeDescription = z
  .string()
  .trim()
  .max(COMMUNITY_BADGE_DESCRIPTION_MAX_LENGTH);

const badgeWriteSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "key is required.")
    .max(COMMUNITY_BADGE_KEY_MAX_LENGTH)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "key must be a slug: lowercase letters, digits and hyphens, starting with a letter or digit."
    ),
  name: badgeName,
  description: badgeDescription.default(""),
  color: badgeColor,
});

const badgePatchSchema = z
  .object({
    name: badgeName.optional(),
    description: badgeDescription.optional(),
    color: badgeColor.optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.color !== undefined,
    "Send at least one of name, description or color."
  );

/**
 * App-facing routes answer schema failures as 400 `{ error }` with Zod's
 * readable message (`parseApiInput` / `prettifyError`).
 */
function parseOrError<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(z.prettifyError(parsed.error), 400);
  }
  return parsed.data;
}

// Helpers --------------------------------------------------------------------

function extractSecret(value: string | undefined): string | null {
  if (value == null || value === "") return null;
  const trimmed = value.trim();
  const bearer = /^Bearer\s+(\S+)/i.exec(trimmed);
  return bearer?.[1] ?? trimmed;
}

function sameSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `parseListQuery`: limit 1–100 (default 50), offset ≥ 0, optional search. */
function parseListQuery(c: ApiContext) {
  const rawLimit = Number(c.req.query("limit") ?? 50);
  const rawOffset = Number(c.req.query("offset") ?? 0);
  return {
    limit: Number.isFinite(rawLimit)
      ? Math.min(100, Math.max(1, Math.trunc(rawLimit)))
      : 50,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0,
    search: c.req.query("search")?.trim() || undefined,
  };
}

function listResponse<T>(rows: T[], query: { limit: number; offset: number }) {
  return {
    data: rows.slice(query.offset, query.offset + query.limit),
    meta: { total: rows.length, limit: query.limit, offset: query.offset },
  };
}

/** Opaque message cursor: base64url of `[createdAt ISO, id]`. */
function encodeCursor(row: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify([row.createdAt, row.id])).toString(
    "base64url"
  );
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(INVALID_CURSOR_ERROR, 400);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !parsed[1]
  ) {
    throw new ApiError(INVALID_CURSOR_ERROR, 400);
  }
  const date = new Date(parsed[0]);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(INVALID_CURSOR_ERROR, 400);
  }
  return { createdAt: date.toISOString(), id: parsed[1] };
}

function parseMessagePageQuery(c: ApiContext) {
  const rawLimit = c.req.query("limit");
  let limit = 50;
  if (rawLimit !== undefined && rawLimit.trim() !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ApiError("limit must be an integer from 1 to 100.", 400);
    }
    limit = parsed;
  }
  const rawCursor = c.req.query("cursor")?.trim();
  return { limit, cursor: rawCursor ? decodeCursor(rawCursor) : null };
}

/** `parseMemberOrContactRef` for an app caller: only `memberId`. */
function requireMemberRef(input: {
  memberId?: string | null;
  contactId?: string | null;
}): string {
  const memberId = input.memberId?.trim() || null;
  const contactId = input.contactId?.trim() || null;
  if (contactId || !memberId) {
    throw new ApiError(APP_MEMBER_ID_REQUIRED_ERROR, 400);
  }
  return memberId;
}

/** `readJsonBody`: malformed or empty JSON is 400 `Invalid JSON body.`. */
async function readJson(c: ApiContext): Promise<unknown> {
  const text = await c.req.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(INVALID_JSON_BODY_ERROR, 400);
  }
}

function param(c: ApiContext, name: string): string {
  return c.req.param(name) ?? "";
}

function errorResponse(c: ApiContext, error: unknown) {
  if (error instanceof ApiError) {
    return c.json(error.body as object, error.status as ContentfulStatusCode);
  }
  if (error instanceof z.ZodError) {
    // `withAPIKey` answers a thrown ZodError with `z.treeifyError`.
    return c.json(z.treeifyError(error) as object, 400);
  }
  return c.json(
    { error: error instanceof Error ? error.message : "Internal server error" },
    500
  );
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": `Authorization, Content-Type, x-api-key, ${APP_INSTALLATION_HEADER}, mcp-session-id, mcp-protocol-version, Last-Event-ID`,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Larger `/api/v1` request bodies get 413. */
export const API_BODY_MAX_BYTES = 1024 * 1024;
export const API_BODY_TOO_LARGE_ERROR = "Request body is larger than 1 MB.";
/** Logged request and response bodies are cut to this many characters. */
export const LOG_BODY_MAX_CHARS = 64 * 1024;

/** Past this, an oversized body isn't drained; the connection is closed. */
const API_BODY_DRAIN_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Buffers the body up to {@link API_BODY_MAX_BYTES}; larger bodies get 413.
 * The rest is read and dropped so the client sees the 413 instead of a reset
 * connection (Hono's `bodyLimit` answers mid-upload).
 */
async function limitBody(c: ApiContext, next: () => Promise<void>) {
  const body = c.req.raw.body;
  if (!body) return next();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size <= API_BODY_MAX_BYTES) chunks.push(chunk);
    else if (size > API_BODY_DRAIN_MAX_BYTES) break;
  }
  if (size > API_BODY_MAX_BYTES) {
    return c.json(
      { error: API_BODY_TOO_LARGE_ERROR },
      413,
      size > API_BODY_DRAIN_MAX_BYTES ? { Connection: "close" } : {}
    );
  }
  c.req.raw = new Request(c.req.raw, {
    body: Buffer.concat(chunks),
    duplex: "half",
  } as RequestInit);
  return next();
}

/** Parsed JSON, or the text cut to {@link LOG_BODY_MAX_CHARS} with a marker. */
export function bodyForLog(text: string): unknown {
  if (!text) return null;
  if (text.length > LOG_BODY_MAX_CHARS) {
    return `${text.slice(0, LOG_BODY_MAX_CHARS)}\n… [truncated: ${text.length - LOG_BODY_MAX_CHARS} more characters]`;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readBodyForLog(c: ApiContext): Promise<unknown> {
  if (!c.get("logBody")) return null;
  if (c.req.method === "GET" || c.req.method === "HEAD") return null;
  try {
    return bodyForLog(await c.req.text());
  } catch {
    return null;
  }
}

async function readResponseForLog(response: Response): Promise<unknown> {
  try {
    return bodyForLog(await response.clone().text());
  } catch {
    return null;
  }
}

// Routes ---------------------------------------------------------------------

export function createApiRoutes(deps: ApiDeps): Hono<ApiEnv> {
  const { store, domain, webhooks, requests } = deps;
  const api = new Hono<ApiEnv>();

  // CORS for the app origin, then the request log.
  api.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowOrigin = origin && origin === deps.appOrigin ? origin : null;

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, allowOrigin ? corsHeaders(allowOrigin) : {});
    }

    c.set("route", null);
    c.set("scope", null);
    c.set("missingScope", null);
    c.set("logBody", false);
    const startedAt = new Date();
    const start = performance.now();

    await next();

    if (allowOrigin) {
      for (const [key, value] of Object.entries(corsHeaders(allowOrigin))) {
        c.res.headers.set(key, value);
      }
    }

    const url = new URL(c.req.url);
    requests.record({
      id: requests.nextId(),
      at: startedAt.toISOString(),
      method: c.req.method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ""),
      route: c.get("route"),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
      scope: c.get("scope"),
      missingScope: c.get("missingScope"),
      // Read after the handler (Hono caches the body), and only once auth
      // passed, so unauthenticated callers never get their body read.
      requestBody: await readBodyForLog(c),
      responseBody: await readResponseForLog(c.res),
    });
    return c.res;
  });

  type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

  /** Registers a route behind app auth and the scope check (`withAPIKey`). */
  const route = (
    method: Method,
    pattern: string,
    requirement: ScopeRequirement,
    handler: (c: ApiContext) => Response | Promise<Response>
  ) => {
    api.on(
      method,
      pattern,
      async (c, next) => {
        c.set("route", `${API_PREFIX}${pattern}`);

        const secret =
          extractSecret(c.req.header("x-api-key")) ??
          extractSecret(c.req.header("authorization"));
        if (!secret || !secret.startsWith("pwa_")) {
          return c.json({ error: API_KEY_ERROR }, 401);
        }
        const installationId =
          c.req.header(APP_INSTALLATION_HEADER)?.trim() ?? "";
        if (
          !sameSecret(secret, deps.appSecret) ||
          installationId !== store.app.installationId
        ) {
          return c.json({ error: APP_AUTH_ERROR }, 401);
        }

        const check = checkScopes(new Set(store.app.scopes), requirement);
        c.set("scope", check.scope);
        if (!check.ok) {
          c.set("missingScope", check.missingScope);
          return c.json(
            {
              error: INSUFFICIENT_SCOPE_ERROR,
              missingScope: check.missingScope,
            },
            403
          );
        }

        return next();
      },
      // After auth, so a caller without credentials never gets its body read.
      limitBody,
      async (c) => {
        c.set("logBody", true);
        try {
          return await handler(c);
        } catch (error) {
          return errorResponse(c, error);
        }
      }
    );
  };

  const one = (scope: AppGrantableScope): ScopeRequirement => ({
    scopes: [scope],
  });

  const requireActiveMember = (memberId: string) =>
    domain.requireMember(memberId, { requireActive: true });

  /** `requireVisibleEvent`: 404 when missing or not flagged for apps. */
  const requireVisibleEvent = (eventId: string): FixtureEvent => {
    const event = domain.event(eventId);
    if (!event) throw new ApiError(EVENT_NOT_FOUND_ERROR, 404);
    if (!event.showInCommunity) {
      throw new ApiError(EVENT_NOT_IN_COMMUNITY_ERROR, 404);
    }
    return event;
  };

  // Members -------------------------------------------------------------

  route("GET", "/community/members", one("COMMUNITY_MEMBERS_READ"), (c) => {
    const query = parseListQuery(c);
    const search = query.search?.toLowerCase();
    const rows = [...store.entities.members]
      .filter(
        (member) =>
          !search ||
          member.displayName.toLowerCase().includes(search) ||
          (member.username?.toLowerCase().includes(search) ?? false)
      )
      .sort(
        (left, right) =>
          left.joinedAt.localeCompare(right.joinedAt) ||
          left.id.localeCompare(right.id)
      )
      .map(toApiMember);
    return c.json(listResponse(rows, query));
  });

  route(
    "GET",
    "/community/members/:memberId",
    one("COMMUNITY_MEMBERS_READ"),
    (c) => {
      const member = domain.member(param(c, "memberId"));
      if (!member) throw new ApiError(MEMBER_NOT_FOUND_ERROR, 404);
      return c.json({ data: toApiMember(member) });
    }
  );

  // Channels and messages -----------------------------------------------

  route(
    "GET",
    "/community/channels",
    {
      scopes: ["COMMUNITY_MESSAGES_READ", "COMMUNITY_MESSAGES_WRITE"],
      anyOf: true,
    },
    (c) =>
      c.json({
        data: sortChannels(
          store.entities.channels.filter((channel) => channel.everyone.view)
        ).map(toApiChannel),
      })
  );

  /** Channels `@everyone` can't view look missing. */
  const requireEveryoneChannel = (channelId: string) => {
    const channel = domain.channel(channelId);
    if (!channel || !channel.everyone.view) {
      throw new ApiError(CHANNEL_NOT_FOUND_ERROR, 404);
    }
    return channel;
  };

  route(
    "GET",
    "/community/channels/:channelId/messages",
    one("COMMUNITY_MESSAGES_READ"),
    (c) => {
      const { limit, cursor } = parseMessagePageQuery(c);
      const channel = requireEveryoneChannel(param(c, "channelId"));
      const rows = store.entities.messages
        .filter(
          (message) => message.channelId === channel.id && !message.deletedAt
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id)
        )
        .filter(
          (message) =>
            !cursor ||
            message.createdAt < cursor.createdAt ||
            (message.createdAt === cursor.createdAt && message.id < cursor.id)
        );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return c.json({
        data: page.map(toApiMessage),
        meta: {
          nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
        },
      });
    }
  );

  route(
    "POST",
    "/community/channels/:channelId/messages",
    one("COMMUNITY_MESSAGES_WRITE"),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      const payload = parseOrError(appMessageInputSchema, body);
      const channel = requireEveryoneChannel(param(c, "channelId"));
      if (!channel.everyone.send) {
        throw new ApiError(APP_CHANNEL_FORBIDDEN_ERROR, 403);
      }
      const { message, events } = domain.postMessage({
        channelId: channel.id,
        body: payload.body,
        replyToId: payload.replyToId ?? null,
        author: {
          kind: "app",
          memberId: null,
          installationId: store.app.installationId,
          name: store.app.name,
        },
      });
      webhooks.dispatch(events);
      return c.json(
        {
          data: {
            id: message.id,
            channelId: message.channelId,
            body: message.body,
            replyToId: message.replyToId,
            createdAt: message.createdAt,
            author: {
              kind: "app" as const,
              installationId: store.app.installationId,
              name: message.author.name,
            },
          },
        },
        201
      );
    }
  );

  // Courses and progress ------------------------------------------------

  route("GET", "/community/courses", one("COURSES_READ"), (c) => {
    const query = parseListQuery(c);
    const rows = domain.visibleCourses().map(toApiCourseSummary);
    return c.json(listResponse(rows, query));
  });

  route("GET", "/community/courses/:courseId", one("COURSES_READ"), (c) => {
    const course = domain.visibleCourse(param(c, "courseId"));
    if (!course) throw new ApiError(COURSE_NOT_FOUND_ERROR, 404);
    return c.json({ data: toApiCourse(course) });
  });

  route(
    "GET",
    "/community/members/:memberId/progress",
    one("COURSES_READ"),
    (c) => {
      const member = domain.requireMember(param(c, "memberId"), {
        requireActive: false,
      });
      const courseId = c.req.query("courseId")?.trim() || undefined;
      if (courseId && !domain.visibleCourse(courseId)) {
        throw new ApiError(COURSE_NOT_FOUND_ERROR, 404);
      }
      return c.json({ data: domain.memberProgress(member.id, courseId) });
    }
  );

  const progressWrite = (completed: boolean) => (c: ApiContext) => {
    const member = requireActiveMember(param(c, "memberId"));
    const { progress, events } = domain.setModuleCompletion({
      member,
      moduleId: param(c, "moduleId"),
      completed,
    });
    webhooks.dispatch(events);
    return c.json({ data: progress });
  };

  route(
    "PUT",
    "/community/members/:memberId/progress/:moduleId",
    one("COURSE_PROGRESS_WRITE"),
    progressWrite(true)
  );
  route(
    "DELETE",
    "/community/members/:memberId/progress/:moduleId",
    one("COURSE_PROGRESS_WRITE"),
    progressWrite(false)
  );

  // Badges ----------------------------------------------------------------

  const badges = one("COMMUNITY_BADGES_WRITE");

  route("GET", "/community/badges", badges, (c) =>
    c.json({
      data: [...store.entities.badges]
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id)
        )
        .map(toApiBadge),
    })
  );

  route("POST", "/community/badges", badges, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const input = parseOrError(badgeWriteSchema, body);
    const { badge, created } = domain.upsertBadge(input);
    return c.json({ data: toApiBadge(badge) }, created ? 201 : 200);
  });

  route("PATCH", "/community/badges/:badgeId", badges, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const patch = parseOrError(badgePatchSchema, body);
    const badge = domain.requireBadge(param(c, "badgeId"));
    return c.json({ data: toApiBadge(domain.updateBadge(badge, patch)) });
  });

  route("DELETE", "/community/badges/:badgeId", badges, (c) => {
    const badge = domain.requireBadge(param(c, "badgeId"));
    domain.deleteBadge(badge);
    return c.json({ data: { id: badge.id, deleted: true } });
  });

  route("PUT", "/community/members/:memberId/badges/:badgeId", badges, (c) => {
    // Status is checked after the badge, so an unknown badge stays a 404.
    const member = domain.requireMember(param(c, "memberId"), {
      requireActive: false,
    });
    const badge = domain.requireBadge(param(c, "badgeId"));
    if (member.status !== "ACTIVE") {
      throw new ApiError(MEMBER_NOT_ACTIVE_ERROR, 409);
    }
    const { award, events } = domain.awardBadge(member, badge);
    webhooks.dispatch(events);
    return c.json({ data: award });
  });

  route(
    "DELETE",
    "/community/members/:memberId/badges/:badgeId",
    badges,
    (c) => {
      const member = domain.requireMember(param(c, "memberId"), {
        requireActive: false,
      });
      const badge = domain.requireBadge(param(c, "badgeId"));
      const { revoked, events } = domain.revokeBadge(member, badge);
      webhooks.dispatch(events);
      return c.json({
        data: { badgeId: badge.id, memberId: member.id, revoked },
      });
    }
  );

  // Events ----------------------------------------------------------------

  route("GET", "/events", one("EVENTS_READ"), (c) => {
    const query = parseListQuery(c);
    const rows = store.entities.events
      .filter((event) => event.showInCommunity)
      .sort((left, right) => right.startsAt.localeCompare(left.startsAt))
      .map((event) => toApiEventListItem(event, store.entities.forms));
    return c.json(listResponse(rows, query));
  });

  route("GET", "/events/:eventId", one("EVENTS_READ"), (c) => {
    const event = requireVisibleEvent(param(c, "eventId"));
    return c.json({ data: toApiEvent(event, store.entities.forms) });
  });

  route(
    "POST",
    "/events/:eventId/registrations",
    one("EVENT_REGISTRATIONS_WRITE"),
    async (c) => {
      const body = parseOrError(eventRegisterSchema, await readJson(c));
      const memberId = requireMemberRef(body);
      const event = requireVisibleEvent(param(c, "eventId"));
      const member = requireActiveMember(memberId);
      const { registration, created, events } = domain.register(event, member);
      webhooks.dispatch(events);
      return c.json(
        {
          data: {
            registration: toApiRegistration(
              registration,
              store.app.workspaceId
            ),
            created,
          },
        },
        created ? 201 : 200
      );
    }
  );

  route(
    "DELETE",
    "/events/:eventId/registrations",
    one("EVENT_REGISTRATIONS_WRITE"),
    (c) => {
      const query = parseOrError(eventCancelQuerySchema, {
        memberId: c.req.query("memberId") ?? undefined,
        contactId: c.req.query("contactId") ?? undefined,
      });
      const memberId = requireMemberRef(query);
      const event = requireVisibleEvent(param(c, "eventId"));
      const member = requireActiveMember(memberId);
      const { contactId, cancelled, events } = domain.cancelRegistration(
        event,
        member
      );
      webhooks.dispatch(events);
      return c.json({ data: { eventId: event.id, contactId, cancelled } });
    }
  );

  route(
    "PUT",
    "/events/:eventId/attendance",
    one("EVENT_REGISTRATIONS_WRITE"),
    async (c) => {
      const { memberId, contactId, ...attendance } = parseOrError(
        eventAttendanceSetForRefSchema,
        await readJson(c)
      );
      const ref = requireMemberRef({ memberId, contactId });
      const event = requireVisibleEvent(param(c, "eventId"));
      const member: FixtureMember = requireActiveMember(ref);
      const { registration, events } = domain.setAttendance(event, member, {
        attendance: attendance.attendance,
        joinedAt:
          attendance.joinedAt === undefined
            ? undefined
            : attendance.joinedAt === null
              ? null
              : new Date(attendance.joinedAt).toISOString(),
        leftAt:
          attendance.leftAt === undefined
            ? undefined
            : attendance.leftAt === null
              ? null
              : new Date(attendance.leftAt).toISOString(),
      });
      webhooks.dispatch(events);
      return c.json({
        data: toApiRegistration(registration, store.app.workspaceId),
      });
    }
  );

  // Forms -----------------------------------------------------------------

  // Production lists `[FORMS_READ, FORMS_SUBMIT]` (any of). Apps can only
  // hold FORMS_SUBMIT, so a 403 names it (`firstMissingScope` picks the
  // first app-grantable scope), and they always get the community-only list.
  route("GET", "/forms", { scopes: ["FORMS_SUBMIT"], anyOf: true }, (c) => {
    const query = parseListQuery(c);
    const search = query.search?.toLowerCase();
    const rows = store.entities.forms
      .filter(
        (form) =>
          form.status === "PUBLISHED" &&
          form.showInCommunity &&
          (!search ||
            form.name.toLowerCase().includes(search) ||
            form.slug.toLowerCase().includes(search))
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toApiCommunityForm);
    return c.json(listResponse(rows, query));
  });

  route(
    "POST",
    "/forms/:formId/submissions",
    one("FORMS_SUBMIT"),
    async (c) => {
      const body = parseOrError(memberFormSubmissionSchema, await readJson(c));
      const form = domain.form(param(c, "formId"));
      if (!form) throw new ApiError(FORM_NOT_FOUND_ERROR, 404);
      if (form.status !== "PUBLISHED") {
        throw new ApiError(FORM_NOT_PUBLISHED_ERROR, 404);
      }
      if (!form.showInCommunity) {
        throw new ApiError(FORM_NOT_IN_COMMUNITY_ERROR, 404);
      }
      const member = requireActiveMember(body.memberId);
      const { submission, events } = domain.submitForm({
        form,
        member,
        fields: body.fields,
        source: "EMBED",
      });
      webhooks.dispatch(events);
      return c.json({ data: toApiSubmission(submission) }, 201);
    }
  );

  api.all("*", (c) => c.json({ error: "Not found." }, 404));

  return api;
}
