import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  PLANEWARD_PERMISSIONS_PATH,
  verifyPlanewardToken,
} from "@planeward/sdk/server";

import {
  tempDir,
  testManifest,
  writeManifest,
} from "../../commands/test-support";
import type { PlanewardManifest } from "../../manifest";
import {
  EMULATOR_ROUTES,
  type EmulatorStateResponse,
  type MintViewerTokenResponse,
  type PermissionsDeclarationResponse,
} from "../contract";
import { startEmulator, type RunningEmulator } from "./index";

const DECLARATION = {
  dashboard: [
    { key: "reports.view", name: "View reports", default: "on" },
    { key: "reports.export", name: "Export reports", default: "off" },
  ],
  community: [
    { key: "posts.create", name: "Create posts", default: "on" },
    { key: "posts.moderate", name: "Moderate posts", default: "off" },
  ],
};

describe("emulator permissions", () => {
  let app: Server;
  let reply: { status: number; body: unknown } = {
    status: 200,
    body: DECLARATION,
  };
  let reads = 0;
  let emulator: RunningEmulator;
  let dir: string;
  let cleanup: () => Promise<void>;
  let manifest: PlanewardManifest;

  before(async () => {
    app = createServer((req, res) => {
      if (req.url === PLANEWARD_PERMISSIONS_PATH) reads += 1;
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    ({ dir, cleanup } = await tempDir());
    manifest = testManifest({
      dashboardPath: "/dashboard",
      dev: {
        command: "true",
        url: appUrl,
        plans: [{ id: "plan_pro", name: "Pro" }],
        grants: { everyone: { "posts.create": "off" } },
      },
    });
    await writeManifest(dir, manifest);
    emulator = await startEmulator({
      manifest,
      manifestPath: join(dir, "planeward.json"),
      stateDir: null,
      port: 0,
    });
  });

  after(async () => {
    await emulator?.close();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await cleanup?.();
  });

  async function call<T>(method: string, path: string, body?: unknown) {
    const response = await fetch(`${emulator.url}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  async function tokenPermissions() {
    const { body } = await call<MintViewerTokenResponse>(
      "POST",
      EMULATOR_ROUTES.token,
      {}
    );
    const claims = await verifyPlanewardToken(body.data.token, {
      appId: emulator.appId,
      baseUrl: emulator.url,
    });
    assert.deepEqual(body.data.permissions, claims.permissions);
    return claims.permissions;
  }

  const setViewer = async (
    role: "member" | "admin",
    planId?: string | null
  ) => {
    const { body } = await call<EmulatorStateResponse>(
      "GET",
      EMULATOR_ROUTES.state
    );
    return call<EmulatorStateResponse>("PUT", EMULATOR_ROUTES.viewer, {
      memberId: body.data.viewer.memberId,
      role,
      planId,
    });
  };

  it("serves the app's declaration, read once until refreshed", async () => {
    const first = await call<PermissionsDeclarationResponse>(
      "GET",
      EMULATOR_ROUTES.permissions
    );
    assert.equal(first.body.data.status, "ok");
    assert.equal(
      first.body.data.url,
      `${manifest.dev.url}${PLANEWARD_PERMISSIONS_PATH}`
    );
    const before = reads;
    await call("GET", EMULATOR_ROUTES.permissions);
    assert.equal(reads, before);
    await call("GET", `${EMULATOR_ROUTES.permissions}?refresh=1`);
    assert.equal(reads, before + 1);
  });

  it("mints tokens with the permissions the simulated viewer resolves to", async () => {
    // The manifest's grants turn posts.create off for @everyone.
    assert.deepEqual(await tokenPermissions(), []);

    await setViewer("member", "plan_pro");
    const saved = await call<EmulatorStateResponse>(
      "PUT",
      EMULATOR_ROUTES.grants,
      {
        everyone: { "posts.create": "off" },
        plans: { plan_pro: { "posts.moderate": "on" }, plan_old: {} },
        dashboard: { "reports.export": true },
      }
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(await tokenPermissions(), ["posts.moderate"]);

    // Saved to planeward.json, empty maps dropped, the rest untouched.
    const file = JSON.parse(
      await readFile(join(dir, "planeward.json"), "utf8")
    );
    assert.deepEqual(file, {
      ...manifest,
      dev: {
        ...manifest.dev,
        grants: {
          everyone: { "posts.create": "off" },
          plans: { plan_pro: { "posts.moderate": "on" } },
          dashboard: { "reports.export": true },
        },
      },
    });
    assert.deepEqual(saved.body.data.grants, file.dev.grants);

    // An admin gets nothing automatically, plan or not.
    await setViewer("admin");
    assert.deepEqual(await tokenPermissions(), []);

    await call("PUT", EMULATOR_ROUTES.view, { view: "dashboard" });
    assert.deepEqual(await tokenPermissions(), [
      "reports.view",
      "reports.export",
    ]);
    await call("PUT", EMULATOR_ROUTES.view, { view: "experience" });
    await setViewer("member", null);
  });

  it("rejects bad grants and unknown plans", async () => {
    const grants = await call<{ error: string }>(
      "PUT",
      EMULATOR_ROUTES.grants,
      {
        everyone: { posts: "maybe" },
      }
    );
    assert.equal(grants.status, 400);
    assert.match(grants.body.error, /^Invalid grants: /);

    const plan = await setViewer("member", "plan_missing");
    assert.equal(plan.status, 400);
  });

  it("gives no permissions while the declaration is invalid", async () => {
    reply = { status: 200, body: { community: [{ key: "Nope" }] } };
    const read = await call<PermissionsDeclarationResponse>(
      "GET",
      `${EMULATOR_ROUTES.permissions}?refresh=1`
    );
    assert.equal(read.body.data.status, "invalid");
    await call("PUT", EMULATOR_ROUTES.grants, {});
    assert.deepEqual(await tokenPermissions(), []);

    reply = { status: 404, body: {} };
    await call("GET", `${EMULATOR_ROUTES.permissions}?refresh=1`);
    assert.deepEqual(await tokenPermissions(), []);
    reply = { status: 200, body: DECLARATION };
  });
});
