# planeward

Local-only CLI for building Planeward community apps. `planeward dev` runs an
emulator of the Planeward host, the v1 API and app webhooks on `127.0.0.1`,
starts your app's dev server with the `PLANEWARD_*` variables pointing at it,
and opens the emulator in your browser.

It needs Node.js 24 or later.

## Quick start

Run it without installing:

```bash
cd my-app                        # the folder with your app's package.json
pnpx planeward@latest init       # writes planeward.json
pnpx planeward@latest dev        # emulator + your dev server
```

`npx planeward@latest init` and `npx planeward@latest dev` work the same way.

## Install

To pin the version, add it to your app as a dev dependency:

```bash
pnpm add -D planeward    # or: npm install -D planeward
```

Then add a script to your app's `package.json`. Keep `dev` as the command
that starts your app, because `planeward dev` runs it:

```json
{
  "scripts": {
    "dev": "next dev --port 3005",
    "dev:emulator": "planeward dev"
  }
}
```

Run `pnpm dev:emulator` to start the emulator and your app together.

## `planeward.json`

`planeward dev` reads the manifest from the current folder or the nearest
parent folder, up to the git root (the first folder with `.git`) or your home
folder, whichever comes first. A manifest found in a parent folder is named,
and `planeward dev` asks before running its `dev.command`. Without a
terminal to ask in, pass `--manifest <path>` or `--no-app`. Its JSON Schema ships in this package at
`schema/planeward.schema.json`. `planeward init` points `$schema` at that
file on unpkg for the installed version, for example
`https://unpkg.com/planeward@0.1.0/schema/planeward.schema.json`.

| Field            | Required | Description                                                                                    |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `$schema`        | no       | URL or path of `schema/planeward.schema.json`, for editor validation.                          |
| `name`           | yes      | Display name in the emulator (1–80 characters).                                                |
| `slug`           | yes      | 2–48 lowercase letters, digits or dashes. The local app id is `<slug>-local`.                  |
| `experiencePath` | yes      | Path on `dev.url` shown in the Experience view, e.g. `/experience`.                            |
| `dashboardPath`  | no       | Path on `dev.url` shown in the Dashboard view (admins).                                        |
| `webhookPath`    | no       | Path on `dev.url` that receives signed webhooks. Without it, every webhook is skipped.         |
| `scopes`         | yes      | Scopes the emulator grants, with no duplicates. Any of the app-grantable scopes below.         |
| `dev.command`    | yes      | Shell command that starts the app, e.g. `next dev --port 3005`. Runs in the manifest's folder. |
| `dev.url`        | yes      | Origin the app serves on, e.g. `http://localhost:3005`.                                        |

App-grantable scopes: `COMMUNITY_MEMBERS_READ`, `COMMUNITY_MESSAGES_READ`,
`COMMUNITY_MESSAGES_WRITE`, `COURSES_READ`, `COURSE_PROGRESS_WRITE`,
`EVENTS_READ`, `EVENT_REGISTRATIONS_WRITE`, `FORMS_SUBMIT`,
`COMMUNITY_BADGES_WRITE`.

```json
{
  "$schema": "https://unpkg.com/planeward@0.1.0/schema/planeward.schema.json",
  "name": "Leaderboard",
  "slug": "leaderboard",
  "experiencePath": "/experience",
  "dashboardPath": "/dashboard",
  "webhookPath": "/api/webhooks/planeward",
  "scopes": ["COMMUNITY_MEMBERS_READ", "COMMUNITY_MESSAGES_READ"],
  "dev": { "command": "next dev --port 3005", "url": "http://localhost:3005" }
}
```

An invalid manifest stops `planeward dev` with one line per problem, such as
`scopes[1]: "ADMIN" is not an app scope` or `dev: unknown field "port"`.

## Commands

Run `planeward <command> --help` for the same reference in the terminal.

### `planeward dev`

```
planeward dev [--port 4600] [--reset] [--no-open] [--no-app] [--manifest <path>]
```

| Option              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `--port <n>`        | Emulator port. Default `4600`; `0` picks a free port.   |
| `--reset`           | Reseed the emulator state before starting.              |
| `--no-open`         | Don't open the emulator in the browser.                 |
| `--no-app`          | Don't run `dev.command`. Start the app yourself.        |
| `--manifest <path>` | Use this `planeward.json` instead of searching for one. |

It runs these steps:

1. Finds and validates `planeward.json`.
2. Keeps the emulator state in `.planeward/` next to the manifest. This
   folder holds the signing key, the local secrets and `state.json`. It is
   created owner-only (`0700`, files `0600`) with its own `.gitignore` of
   `*`, so git ignores it without a root entry. `planeward dev` still
   suggests adding `.planeward/` to the `.gitignore` next to the manifest or
   at the repo root when neither lists it. It doesn't edit either file.
3. Starts the emulator on `http://127.0.0.1:<port>`.
4. Runs `dev.command` through the shell in the manifest's folder. Local
   `node_modules/.bin` folders are added to `PATH`, as `npm run` does, so
   `next dev --port 3005` works directly. The command gets your environment
   plus four variables:

   | Variable                   | Value                                                                                               |
   | -------------------------- | --------------------------------------------------------------------------------------------------- |
   | `PLANEWARD_BASE_URL`       | `http://127.0.0.1:<port>`. This is also the viewer-token issuer, so don't change it to `localhost`. |
   | `PLANEWARD_APP_ID`         | `<slug>-local`                                                                                      |
   | `PLANEWARD_APP_SECRET`     | `pwa_local_…`                                                                                       |
   | `PLANEWARD_WEBHOOK_SECRET` | `whsec_local_…`                                                                                     |

   Nothing is written to your `.env` files, so they keep your real values.
   The injected values win over `.env` files only when the framework lets
   process env take priority. **Next.js does:** it loads `process.env` first
   and never overrides a variable that's already set from `.env*`. Vite and
   `dotenv` (without `override: true`) behave the same way. If your framework
   overwrites process env from `.env`, remove the `PLANEWARD_*` lines from
   your `.env` while you use the emulator.

5. Prints a banner with the emulator URL, the app URL, the granted scopes and
   the four variable names. The secret values are masked.
6. Opens the emulator unless you pass `--no-open`.
7. Streams one line per API call and webhook delivery:

   ```
   [planeward] → 200 GET /api/v1/community/members 12ms
   [planeward] → 403 GET /api/v1/events 3ms  missing EVENTS_READ: add EVENTS_READ to planeward.json scopes and restart planeward dev
   [planeward] ⇢ 200 community.message.created 34ms
   [planeward] ⇢ skipped community.module.completed: Installation is not granted COURSES_READ.
   [app] ▲ Next.js ready on http://localhost:3005
   ```

   The CLI's lines start with `[planeward]` and your app's output starts
   with `[app]`.

While it runs:

- Press `r` to reset the state to the seed data. This needs an interactive
  terminal; otherwise restart with `--reset`.
- Press Ctrl-C, or send SIGTERM, to stop. The CLI stops the app's whole
  process tree, closes the emulator, writes the state and exits 0. On
  Windows it uses `taskkill /T`. A second Ctrl-C exits at once.
- If the app exits on its own, the emulator keeps running and the CLI prints
  a hint.

With `--no-app`, start the app yourself with the four variables. The secrets
are in `.planeward/keys.json` (`appSecret` and `webhookSecret`).

The manifest is read once at startup. Restart `planeward dev` after you edit
it, for example to add a scope.

### `planeward trigger`

```
planeward trigger <event> [--member <id>] [--port 4600]
```

This command asks a running emulator to send one webhook event. The emulator
builds the event from its current state, using the member's latest message,
completed module, registration, submission or badge. It then sends the event
to `dev.url + webhookPath`, waits for the response and prints the result:

```
[planeward] ⇢ 200 community.message.created 21ms
[planeward]   http://localhost:3005/api/webhooks/planeward
[planeward]   delivery 4b0c…
```

| Option          | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `--member <id>` | Member the event is about. Default: the emulator's current viewer. |
| `--port <n>`    | Port of the running emulator. Default `4600`.                      |

The command exits 0 when the app answered with a 2xx status. It exits 1 when
the delivery failed or was skipped, or when it can't reach an emulator. It
exits 2 for an unknown event.

Events: `app.installed`, `app.uninstalled`,
`community.membership.granted`, `community.membership.suspended`,
`community.membership.resumed`, `community.membership.revoked`,
`community.message.created`, `community.message.deleted`,
`community.reaction.added`, `community.reaction.removed`,
`community.module.completed`, `community.course.completed`,
`event.registered`, `event.registration_cancelled`,
`event.attendance_classified`, `form.submitted`, `community.badge.awarded`,
`community.badge.revoked`.

### `planeward init`

```
planeward init [--yes]
```

This command creates `planeward.json` in the current folder. It never
overwrites an existing one. It fills the fields like this:

- `name` and `slug` come from the `package.json` `name`, without the npm
  scope. Without a `package.json`, they come from the folder name.
- `dev.command` is the `dev` script. `dev.url` is `http://localhost:<port>`,
  where the port comes from `--port`, `-p` or `PORT=` in that script, and
  defaults to 3000. If the script uses `--experimental-https`, the URL uses
  `https`.
- The paths are `/experience`, `/dashboard` and `/api/webhooks/planeward`.
- `scopes` is `["COMMUNITY_MEMBERS_READ"]`.
- `$schema` is the unpkg URL of the schema for the running version:
  `https://unpkg.com/planeward@<version>/schema/planeward.schema.json`.

The command shows the manifest and asks before writing it. Pass `--yes` to
skip the question.

### `planeward --help`, `--version`

`planeward --help` and `planeward help <command>` print the help. You can
also pass `--help` to any command.

## What the emulator mirrors

- **Viewer tokens:** RS256, with the same claims, issuer, audience and
  5-minute expiry as production, plus `GET /api/auth/jwks`.
  `verifyPlanewardToken` from `@planeward/sdk/server` works unchanged. The
  key is generated once per project in `.planeward/keys.json`.
- **Host protocol:** the emulator hosts your app in an iframe. It answers
  `ready` with a token, refreshes tokens on `token-request`, and sends
  `theme` changes. It locks messages to the app's origin. You can switch the
  viewer (any seeded member, as `member` or `admin`), the view (Experience or
  Dashboard) and the theme.
- **API:** every app-grantable `/api/v1` endpoint, backed by a seeded store:
  - community members, channels and messages
  - courses and progress
  - events, registrations and attendance
  - forms and submissions
  - badges and member badges, with the same 50-badges-per-app cap (a new
    key past it is a 409; an existing key still updates) and validation
    messages

  Auth uses the local `pwa_` secret plus `x-planeward-installation`. Scopes
  are the manifest's `scopes`. A missing scope returns the same 403 body
  with `missingScope` as production, always a scope an app can be granted
  (`FORMS_SUBMIT` on `GET /forms`). Visibility rules match production:
  private channels and events or forms not shown in community are hidden,
  and courses (with their progress) are listed only when published and sold
  through a product. App responses leave out what production leaves out for
  apps: events have no `pipeline` or `pipelineId`, and `form` / `formId` are
  `null` unless that form is published and shown in community; registrations
  have no `contact` or `opportunityId`; `GET /forms` has the real
  `submissionCount` and only `respondent`, `theme` and `css` in `settings`.
  Errors match too: malformed JSON on events and forms writes is 400
  `{ "error": "Invalid JSON body." }`, invalid bodies are 400 `{ error }`
  with Zod's readable message, and an RSVP or form submission for a member
  whose customer has no email but other contacts (seeded as `member_21`,
  Rafael Costa) is 409 `Member has no primary contact.`.
  `community.course.completed` goes out once per member and course.
  Response shapes are tested against the Planeward OpenAPI spec.

- **Webhooks:** signed like production, with the same `X-Planeward-Signature`,
  `-Delivery` and `-Event` headers and envelope. They're gated by the same
  scope map. You can send them from the Activity panel, from
  `planeward trigger`, and with Redeliver. A redelivery keeps the delivery id.
  `app.installed` is sent on the first start (fresh state) once the app
  answers, waiting up to 60 seconds.
- **State** persists in `.planeward/state.json` across restarts. Use
  `--reset` or `r` to reseed it. State saved by an older emulator version is
  reseeded on start.

## Where it diverges from production

- **Badges:** the API and webhooks store and return awarded badges, but the
  emulator's host UI doesn't show them next to members or their messages
  the way the community chat does.
- **No rate limiting.** Production answers 429
  `{ "error": "Too many API requests. Try again shortly." }` with
  `Retry-After` once a key or installation is over its limit, counting
  calls before the scope check. The emulator never returns 429.
- **No localhost-app check.** Production refuses calls with 403 for an app
  whose URLs are still localhost when its installation is outside the
  publisher's workspace. The emulator has one local installation, so it
  never does.
- **No pipelines or avatars.** Registrations and submissions don't create
  opportunities, so a form submission's `opportunityId` is always `null`
  (apps never see pipelines or registration `opportunityId`, as in
  production). Webhooks match production: `event.*` and `form.submitted`
  carry `memberId` (the member whose contact it is, or `null`) and no
  `opportunityId` or `customerId`. Seeded members have `avatarUrl: null`.
- **Contacts are a flag.** The emulator has no CRM customers or contacts. A
  member has a `contactId` (created on their first RSVP or form submission)
  or `contactConflict`, which stands in for production's "customer has no
  email and several contacts" 409.
- **Request size:** `/api/v1` bodies over 1 MB get 413
  `{ "error": "Request body is larger than 1 MB." }`. The request log keeps
  the first 64 KB of each body and marks the rest as truncated, and doesn't
  record bodies of calls that fail auth.
- **Skipped webhooks are visible.** Production silently drops events the
  installation can't receive. The emulator records them as `skipped` with
  the reason, for example a missing scope or no `webhookPath`.
- **Retries:** a delivery is tried once and retried once after a network
  error, not on production's longer schedule.
- **Single installation:** one workspace (`workspace_local`) and one
  installation (`installation_local`), bound to `127.0.0.1` only.
- **Local-only host routes:** the UI's `/__emulator` routes accept only the
  emulator's own origin (`http://127.0.0.1:<port>` or
  `http://localhost:<port>`). Calls without an `Origin`, such as `curl` or
  `planeward trigger`, need a `Host` that names the emulator. The host UI
  can't be framed (`X-Frame-Options: DENY`,
  `frame-ancestors 'none'`).

## Developing the CLI

The CLI depends on `@planeward/sdk`. While the sdk version it needs isn't on
npm yet, `pnpm-workspace.yaml` overrides it with a link to a sibling checkout
at `../sdk`, so clone both repos side by side and build the sdk first:

```bash
cd ../sdk && pnpm install && pnpm build && cd ../cli
pnpm install
pnpm build       # dist/bin.js + dist/ui
```

When the override isn't there, `pnpm install` takes the sdk from npm.

```bash
pnpm typecheck
pnpm lint
pnpm test        # tsx --test
pnpm format:check
```

To use your build in an app, run `pnpm link --global` here, then
`planeward dev` in the app folder. Run `pnpm build` again after pulling
changes; the link points at this folder's `dist/`.

`pnpm dev:ui` serves the host UI from Vite on `http://127.0.0.1:4601` and
proxies to an emulator on port 4600. Start that emulator with
`PLANEWARD_EMULATOR_DEV_UI=1 planeward dev` so its `/__emulator` routes
accept the Vite origin.

The emulator tests check mock API responses against the Planeward OpenAPI
spec in `fixtures/openapi.yaml`. Refresh it with `pnpm update-openapi`. It reads `PLANEWARD_OPENAPI`
(a path or URL), then `../../workbench/apps/docs/openapi/v1.yaml`, then
`https://docs.planeward.com/openapi.json`. `pnpm update-openapi --check`
only compares the source with the fixture and exits 1 when they differ.

## Releasing

1. On `main`, run `pnpm release` (or `pnpm release patch|minor|major`). bumpp updates `package.json`, commits `chore(release): vX.Y.Z` and creates the tag `vX.Y.Z`.
2. Push the commit and tag: `git push --follow-tags`.

The `Release` workflow (`.github/workflows/release.yml`) runs on that tag in the `Release` environment. It checks that the tag matches `package.json`, builds, typechecks, tests, lints, publishes to npm with trusted publishing (OIDC, with provenance), creates a GitHub release and moves the `latest` tag to the released commit. No npm token is stored in the repo. If that version is already on npm, the publish step is skipped and the release and `latest` tag are still created, so re-running a failed release is safe.

To check a release locally: `pnpm build && pnpm test && pnpm pack --dry-run`.

## License

MIT
