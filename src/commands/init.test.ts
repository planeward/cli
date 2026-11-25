import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { validatePermissionsResponse } from "@planeward/sdk/server";

import { CliError } from "./errors";
import {
  inferManifest,
  inferPermissionsRoute,
  PERMISSIONS_ROUTE_SOURCE,
  portFromScript,
  runInit,
  slugify,
} from "./init";
import { validateManifest } from "./manifest-file";
import { manifestSchemaUrl, packageVersion } from "./package-info";
import { captureOutput, tempDir } from "./test-support";

const SCHEMA = "https://unpkg.com/planeward@1.2.3/schema/planeward.schema.json";

describe("planeward init", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  before(async () => {
    ({ dir: root, cleanup } = await tempDir());
  });
  after(() => cleanup());

  async function appDir(name: string, pkg?: unknown) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    if (pkg) await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    return dir;
  }

  it("infers name, slug, dev.command and dev.url from package.json", async () => {
    const dir = await appDir("web", {
      name: "@acme/leader-board",
      scripts: { dev: "next dev --turbopack --port 3005" },
    });
    const { manifest, notes } = inferManifest(dir, SCHEMA);
    assert.deepEqual(notes, []);
    assert.deepEqual(manifest, {
      $schema: SCHEMA,
      name: "Leader Board",
      slug: "leader-board",
      experiencePath: "/experience",
      dashboardPath: "/dashboard",
      webhookPath: "/api/webhooks/planeward",
      scopes: ["COMMUNITY_MEMBERS_READ"],
      dev: {
        command: "next dev --turbopack --port 3005",
        url: "http://localhost:3005",
      },
    });
    assert.equal(validateManifest(manifest).ok, true);
  });

  it("falls back when the script has no port or there is no package.json", async () => {
    const noPort = await appDir("no-port", {
      name: "app",
      scripts: { dev: "next dev" },
    });
    const inferred = inferManifest(noPort, SCHEMA);
    assert.equal(inferred.manifest.dev.url, "http://localhost:3000");
    assert.match(inferred.notes.join(" "), /assumed 3000/);

    const bare = await appDir("Bare Folder");
    const fallback = inferManifest(bare, SCHEMA);
    assert.equal(fallback.manifest.slug, "bare-folder");
    assert.equal(fallback.manifest.dev.command, "npm run dev");
    assert.match(fallback.notes.join(" "), /No package\.json/);

    const https = await appDir("https", {
      name: "secure",
      scripts: { dev: "next dev --experimental-https -p 3443" },
    });
    assert.equal(
      inferManifest(https, SCHEMA).manifest.dev.url,
      "https://localhost:3443"
    );
  });

  it("parses ports and slugs", () => {
    assert.equal(portFromScript("vite --port=5174"), 5174);
    assert.equal(portFromScript("PORT=4000 node server.js"), 4000);
    assert.equal(portFromScript("next dev"), null);
    assert.equal(slugify("My_Cool App!!"), "my-cool-app");
  });

  it("points $schema at this version's schema on unpkg", async () => {
    assert.equal(manifestSchemaUrl("1.2.3"), SCHEMA);
    const dir = await appDir("schema", { name: "schema-app" });
    assert.equal(
      inferManifest(dir).manifest.$schema,
      `https://unpkg.com/planeward@${packageVersion()}/schema/planeward.schema.json`
    );
  });

  it("writes with --yes and refuses to overwrite", async () => {
    const dir = await appDir("write", {
      name: "writer",
      scripts: { dev: "next dev -p 3007" },
    });
    const output = captureOutput();
    assert.equal(
      await runInit(
        { yes: true, help: false },
        { cwd: dir, output, schemaUrl: SCHEMA }
      ),
      0
    );
    const written = JSON.parse(
      readFileSync(join(dir, "planeward.json"), "utf8")
    );
    assert.equal(written.dev.url, "http://localhost:3007");
    assert.match(output.text(), /Wrote /);

    await assert.rejects(
      runInit(
        { yes: true, help: false },
        { cwd: dir, output, schemaUrl: SCHEMA }
      ),
      (error: unknown) =>
        error instanceof CliError && /already exists/.test(error.message)
    );
  });

  it("asks before writing and writes nothing on no", async () => {
    const dir = await appDir("ask", {
      name: "asker",
      scripts: { dev: "next dev -p 3008" },
    });
    const questions: string[] = [];
    const code = await runInit(
      { yes: false, help: false },
      {
        cwd: dir,
        output: captureOutput(),
        schemaUrl: SCHEMA,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
      }
    );
    assert.equal(code, 1);
    assert.deepEqual(questions, [
      "Write planeward.json and app/.well-known/planeward-permissions/route.js? (Y/n) ",
    ]);
    assert.equal(existsSync(join(dir, "planeward.json")), false);
    assert.equal(existsSync(join(dir, "app")), false);
  });

  it("scaffolds a permissions route in a Next.js app, never over an existing one", async () => {
    const dir = await appDir("next-src", {
      name: "next-src",
      scripts: { dev: "next dev -p 3009" },
      dependencies: { next: "16.0.0", "@planeward/sdk": "^0.2.4" },
    });
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const output = captureOutput();
    assert.equal(
      await runInit(
        { yes: true, help: false },
        { cwd: dir, output, schemaUrl: SCHEMA }
      ),
      0
    );
    const route = "src/app/.well-known/planeward-permissions/route.ts";
    assert.equal(
      readFileSync(join(dir, route), "utf8"),
      PERMISSIONS_ROUTE_SOURCE
    );
    assert.doesNotMatch(output.text(), /npm install @planeward\/sdk/);

    assert.deepEqual(inferPermissionsRoute(dir), {
      route: null,
      notes: [`${route} already exists; left as is.`],
    });
  });

  it("skips the route outside Next.js and asks for the SDK when it's missing", async () => {
    const vite = await appDir("vite", {
      name: "vite-app",
      scripts: { dev: "vite --port 5174" },
    });
    const skipped = inferPermissionsRoute(vite);
    assert.equal(skipped.route, null);
    assert.match(skipped.notes.join(" "), /Not a Next\.js app/);

    const next = await appDir("next-no-sdk", {
      name: "next-no-sdk",
      devDependencies: { next: "16.0.0" },
    });
    const inferred = inferPermissionsRoute(next);
    assert.equal(
      inferred.route?.path,
      "app/.well-known/planeward-permissions/route.js"
    );
    assert.deepEqual(inferred.notes, [
      "The permissions route imports @planeward/sdk: npm install @planeward/sdk",
    ]);
  });

  it("starts the route from a declaration the SDK accepts", () => {
    const literal = /definePermissions\((\{[\s\S]*?\n\})\);/.exec(
      PERMISSIONS_ROUTE_SOURCE
    )?.[1];
    assert.ok(literal);
    // The object literal is plain JS: evaluate it and validate it.
    const declaration: unknown = new Function(`return (${literal});`)();
    assert.equal(validatePermissionsResponse(declaration).ok, true);
  });
});
