import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { PLANEWARD_PERMISSIONS_PATH } from "@planeward/sdk/server";

import { CliError, UsageError } from "./errors";
import { parsePermissionsArgs, runPermissions } from "./permissions";
import {
  captureOutput,
  tempDir,
  testManifest,
  writeManifest,
} from "./test-support";

describe("planeward permissions", () => {
  let server: Server;
  let origin: string;
  let reply: { status: number; body: string } = { status: 404, body: "" };
  const paths: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = async (url = `${origin}/experience`) => {
    const output = captureOutput();
    const code = await runPermissions(
      { url, manifest: undefined, help: false },
      { output }
    );
    return { code, text: output.text() };
  };

  it("prints both lists from the origin's well-known path", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        community: [
          {
            key: "posts.moderate",
            name: "Moderate posts",
            description: "Hide and pin posts.",
            default: "off",
          },
        ],
      }),
    };
    const { code, text } = await run();
    assert.equal(code, 0);
    assert.equal(paths.at(-1), PLANEWARD_PERMISSIONS_PATH);
    assert.match(text, /Dashboard \(0\)[^\n]*\n {2}\(none\)/);
    assert.match(text, /Community \(1\)/);
    assert.match(
      text,
      /^ {2}posts\.moderate {2}Moderate posts {2}off {6}Hide and pin posts\.$/m
    );
  });

  it("treats a 404 as no permissions declared", async () => {
    reply = { status: 404, body: "" };
    const { code, text } = await run();
    assert.equal(code, 0);
    assert.match(text, /No permissions declared/);
  });

  it("lists every problem and exits 1 when the declaration is invalid", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        dashboard: [{ key: "Reports", name: "", default: "yes" }],
      }),
    };
    const { code, text } = await run();
    assert.equal(code, 1);
    assert.match(text, /is invalid \(3 problems\)/);
    assert.match(text, /- dashboard\[0\]\.key: "Reports" must be dotted/);
    assert.match(text, /- dashboard\[0\]\.default: must be "on" or "off"\./);

    reply = { status: 200, body: "<html>" };
    assert.match((await run()).text, /\(root\): not valid JSON/);
  });

  it("fails on other statuses and when nothing answers", async () => {
    reply = { status: 500, body: "{}" };
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /answered HTTP 500/);
      return true;
    });
    // A port that was free a moment ago: nothing listens on it.
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve)
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await assert.rejects(
      run(`http://127.0.0.1:${port}`),
      /Nothing answered on http:\/\/127\.0\.0\.1:\d+\. Is the app running\?/
    );
  });

  it("reads dev.url from planeward.json", async () => {
    reply = { status: 404, body: "" };
    const { dir, cleanup } = await tempDir();
    try {
      await writeManifest(
        dir,
        testManifest({ dev: { command: "x", url: origin } })
      );
      const output = captureOutput();
      assert.equal(
        await runPermissions(
          { url: undefined, manifest: undefined, help: false },
          { cwd: dir, output }
        ),
        0
      );
      assert.match(
        output.text(),
        new RegExp(`${origin}${PLANEWARD_PERMISSIONS_PATH}`)
      );
    } finally {
      await cleanup();
    }
  });

  it("rejects a --url that isn't http(s)", () => {
    assert.throws(
      () => parsePermissionsArgs(["--url", "localhost:3000"]),
      UsageError
    );
  });
});
