/**
 * `planeward.json`: the app manifest `planeward dev` reads from the app
 * folder. JSON Schema: `schema/planeward.schema.json` (keep both in sync;
 * `manifest.test.ts` checks the scope list).
 */

export const MANIFEST_FILE_NAME = "planeward.json";

export const MANIFEST_SCHEMA_PATH = "schema/planeward.schema.json";

/**
 * API permissions a community app may request (Planeward
 * `APP_GRANTABLE_PERMISSION_KEYS`, `apps/web/src/server/apps/permissions.ts`).
 * The emulator grants exactly the manifest's `scopes`.
 */
export const APP_GRANTABLE_SCOPES = [
  "COMMUNITY_MEMBERS_READ",
  "COMMUNITY_MESSAGES_READ",
  "COMMUNITY_MESSAGES_WRITE",
  "COURSES_READ",
  "COURSE_PROGRESS_WRITE",
  "EVENTS_READ",
  "EVENT_REGISTRATIONS_WRITE",
  "FORMS_SUBMIT",
  "COMMUNITY_BADGES_WRITE",
  "COMMUNITY_NOTIFICATIONS_WRITE",
] as const;

export type AppGrantableScope = (typeof APP_GRANTABLE_SCOPES)[number];

export type PlanewardManifest = {
  /** Optional `$schema` pointer for editors. */
  $schema?: string;
  /** Display name shown in the emulator host. */
  name: string;
  /** Lowercase slug; the local app id is `<slug>-local`. */
  slug: string;
  /** Path on `dev.url` rendered in the Experience view, e.g. `/experience`. */
  experiencePath: string;
  /** Path on `dev.url` rendered in the Dashboard view (admins). */
  dashboardPath?: string;
  /** Path on `dev.url` that receives signed webhooks, e.g. `/api/webhooks/planeward`. */
  webhookPath?: string;
  /** Scopes the emulator grants the app. Duplicates are not allowed. */
  scopes: AppGrantableScope[];
  dev: {
    /** Shell command that starts the app, e.g. `next dev --port 3005`. */
    command: string;
    /** Origin the app serves on, e.g. `http://localhost:3005`. */
    url: string;
  };
};

export function isAppGrantableScope(value: string): value is AppGrantableScope {
  return (APP_GRANTABLE_SCOPES as readonly string[]).includes(value);
}
