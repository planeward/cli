/** Local-only hardening: origins, body limits, framing, state file modes, badge cap. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { APP_GRANTABLE_SCOPES, type PlanewardManifest } from "../../manifest";
import { EMULATOR_ROUTES, type ApiRequestLogResponse } from "../contract";
import { API_BODY_TOO_LARGE_ERROR, LOG_BODY_MAX_CHARS } from "./api";
import { BADGE_LIMIT_ERROR, COMMUNITY_BADGE_LIMIT_PER_APP } from "./domain";
import { DEV_UI_ORIGIN } from "./emulator-routes";
import { startEmulator, type RunningEmulator } from "./index";
import { STATE_DIR_GITIGNORE } from "./state-dir";
import { STATE_FILE_NAME } from "./store";

const manifest: PlanewardManifest = {
  name: "Leaderboard",
  slug: "leaderboard",
  experiencePath: "/experience",
  scopes: [...APP_GRANTABLE_SCOPES],
  dev: { command: "true", url: "http://127.0.0.1:9" },
};

/** Raw HTTP so the test controls `Host` (fetch won't let it). */
function rawGet(
  emulator: RunningEmulator,
  path: string,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: emulator.port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("emulator hardening", () => {
  let stateDir: string;
  let emulator: RunningEmulator;
  let devUi: RunningEmulator;

  const api = async (method: string, path: string, body?: string) => {
    const response = await fetch(`${emulator.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${emulator.appSecret}`,
        "x-planeward-installation": emulator.installationId,
        "Content-Type": "application/json",
      },
      body,
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  before(async () => {
    stateDir = join(
      await mkdtemp(join(tmpdir(), "planeward-hardening-")),
      ".planeward"
    );
    emulator = await startEmulator({
      manifest,
      stateDir,
      port: 0,
      allowDevUiOrigin: false,
    });
    devUi = await startEmulator({
      manifest,
      stateDir: null,
      port: 0,
      allowDevUiOrigin: true,
    });
  });

  after(async () => {
    await emulator?.close();
    await devUi?.close();
    if (stateDir) await rm(join(stateDir, ".."), { recursive: true });
  });

  it("lets only the emulator's own origin call /__emulator", async () => {
    const host = `127.0.0.1:${emulator.port}`;
    const state = EMULATOR_ROUTES.state;
    const call = (headers: Record<string, string>) =>
      rawGet(emulator, state, headers);

    assert.equal(await call({ Host: host }), 200, "no Origin (CLI, curl)");
    assert.equal(await call({ Host: host, Origin: `http://${host}` }), 200);
    assert.equal(
      await call({
        Host: `localhost:${emulator.port}`,
        Origin: `http://localhost:${emulator.port}`,
      }),
      200
    );
    assert.equal(
      await call({ Host: host, Origin: "http://127.0.0.1:3000" }),
      403,
      "another loopback port"
    );
    assert.equal(
      await call({ Host: host, Origin: "http://localhost:5173" }),
      403
    );
    assert.equal(await call({ Host: host, Origin: DEV_UI_ORIGIN }), 403);
    assert.equal(
      await call({ Host: "127.0.0.1:1" }),
      403,
      "Host on another port"
    );
    assert.equal(
      await call({ Host: `rebound.example:${emulator.port}` }),
      403,
      "DNS-rebound Host"
    );

    const devHost = `127.0.0.1:${devUi.port}`;
    assert.equal(
      await rawGet(devUi, state, { Host: devHost, Origin: DEV_UI_ORIGIN }),
      200,
      "Vite dev UI with PLANEWARD_EMULATOR_DEV_UI"
    );
    assert.equal(
      await rawGet(devUi, state, {
        Host: devHost,
        Origin: "http://127.0.0.1:3000",
      }),
      403
    );
  });

  it("caps /api/v1 bodies at 1 MB and truncates logged bodies", async () => {
    const huge = JSON.stringify({ body: "x".repeat(1024 * 1024) });
    const tooLarge = await api(
      "POST",
      "/community/channels/channel_general/messages",
      huge
    );
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(tooLarge.body, { error: API_BODY_TOO_LARGE_ERROR });

    const big = JSON.stringify({
      memberId: "member_02",
      fields: { wins: "y".repeat(100 * 1024) },
    });
    await api("POST", "/forms/form_checkin/submissions", big);

    const unauthenticated = await fetch(
      `${emulator.url}/api/v1/community/badges`,
      { method: "POST", body: '{"secret":"unread"}' }
    );
    assert.equal(unauthenticated.status, 401);

    const log = (await (
      await fetch(`${emulator.url}${EMULATOR_ROUTES.requests}`)
    ).json()) as ApiRequestLogResponse;
    const entries = log.data;
    const rejected = entries.find((entry) => entry.status === 413)!;
    assert.equal(rejected.requestBody, null, "413 bodies are not logged");
    const truncated = entries.find(
      (entry) => entry.path === "/api/v1/forms/form_checkin/submissions"
    )!;
    assert.equal(typeof truncated.requestBody, "string");
    assert.ok(
      (truncated.requestBody as string).length < LOG_BODY_MAX_CHARS + 100
    );
    assert.match(truncated.requestBody as string, /\[truncated: \d+ more/);
    const denied = entries.find((entry) => entry.status === 401)!;
    assert.equal(denied.requestBody, null, "unauthenticated bodies are unread");
  });

  it("refuses to be framed", async () => {
    const response = await fetch(`${emulator.url}/`);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(
      response.headers.get("content-security-policy"),
      "frame-ancestors 'none'"
    );
  });

  it("keeps .planeward owner-only and ignored by git", async () => {
    await emulator.instance.store.flush();
    emulator.instance.store.changed();
    await emulator.instance.store.flush();
    if (process.platform !== "win32") {
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(stateDir, STATE_FILE_NAME))).mode & 0o777,
        0o600
      );
      assert.equal(
        (await stat(join(stateDir, "keys.json"))).mode & 0o777,
        0o600
      );
    }
    assert.equal(
      await readFile(join(stateDir, ".gitignore"), "utf8"),
      STATE_DIR_GITIGNORE
    );
  });

  it("caps badges at 50 per app, but still updates existing keys", async () => {
    const existing = emulator.instance.store.entities.badges.length;
    for (let n = existing; n < COMMUNITY_BADGE_LIMIT_PER_APP; n += 1) {
      const created = await api(
        "POST",
        "/community/badges",
        JSON.stringify({
          key: `badge-${n}`,
          name: `Badge ${n}`,
          color: "#7C3AED",
        })
      );
      assert.equal(created.status, 201);
      assert.equal(created.body.data.color, "#7c3aed");
    }
    const over = await api(
      "POST",
      "/community/badges",
      JSON.stringify({ key: "one-too-many", name: "Nope", color: "#7c3aed" })
    );
    assert.deepEqual(over, { status: 409, body: { error: BADGE_LIMIT_ERROR } });

    const updated = await api(
      "POST",
      "/community/badges",
      JSON.stringify({ key: "badge-1", name: "Renamed", color: "#000000" })
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, "Renamed");
  });

  it("answers bad badge input with the production messages", async () => {
    const bad = await api(
      "POST",
      "/community/badges",
      JSON.stringify({ key: "Bad Key", name: "", color: "purple" })
    );
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /key must be a slug/);
    assert.match(bad.body.error, /name is required\./);
    assert.match(bad.body.error, /color must be a hex color like #7c3aed\./);

    const emptyPatch = await api(
      "PATCH",
      "/community/badges/badge_missing",
      "{}"
    );
    assert.equal(emptyPatch.status, 400);
    assert.match(
      emptyPatch.body.error,
      /Send at least one of name, description or color\./
    );

    const missing = await api(
      "PATCH",
      "/community/badges/badge_missing",
      JSON.stringify({ name: "x" })
    );
    assert.deepEqual(missing, {
      status: 404,
      body: { error: "Badge not found." },
    });

    // Unknown badge stays a 404 even for a member who isn't active.
    const suspended = emulator.instance.store.entities.members.find(
      (member) => member.status !== "ACTIVE"
    )!;
    const award = await api(
      "PUT",
      `/community/members/${suspended.id}/badges/badge_missing`
    );
    assert.equal(award.status, 404);
  });
});
