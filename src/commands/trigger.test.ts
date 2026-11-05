import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  PLANEWARD_EVENT_HEADER,
  PLANEWARD_SIGNATURE_HEADER,
} from "@planeward/sdk/server";

import { startEmulator, type RunningEmulator } from "../emulator/server/index";
import { CliError } from "./errors";
import { captureOutput, testManifest } from "./test-support";
import { runTrigger, triggerEvent } from "./trigger";

type Received = { headers: IncomingHttpHeaders; body: string };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("planeward trigger", () => {
  let receiver: Server;
  let received: Received[];
  let emulator: RunningEmulator;

  before(async () => {
    received = [];
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.method === "POST")
          received.push({ headers: req.headers, body });
        res.writeHead(200).end("ok");
      });
    });
    const appPort = await listen(receiver);
    emulator = await startEmulator({
      manifest: testManifest({
        webhookPath: "/api/webhooks/planeward",
        scopes: ["COMMUNITY_MEMBERS_READ", "COMMUNITY_MESSAGES_READ"],
        dev: { command: "true", url: `http://127.0.0.1:${appPort}` },
      }),
      stateDir: null,
      port: 0,
    });
    await emulator.idle();
  });

  after(async () => {
    await emulator?.close();
    await new Promise((resolve) => receiver?.close(resolve));
  });

  it("sends the event through a running emulator and returns the delivery", async () => {
    received.length = 0;
    const entry = await triggerEvent({
      event: "community.message.created",
      port: emulator.port,
    });
    assert.equal(entry.status, "succeeded");
    assert.equal(entry.httpStatus, 200);
    assert.equal(entry.event, "community.message.created");
    assert.equal(received.length, 1);
    assert.equal(
      received[0]!.headers[PLANEWARD_EVENT_HEADER],
      "community.message.created"
    );
    assert.match(
      String(received[0]!.headers[PLANEWARD_SIGNATURE_HEADER]),
      /^sha256=/
    );
  });

  it("prints the result and exits 0 when delivered", async () => {
    const output = captureOutput();
    const code = await runTrigger(
      {
        event: "community.membership.granted",
        member: undefined,
        port: emulator.port,
        help: false,
      },
      { output }
    );
    assert.equal(code, 0);
    assert.match(output.text(), /⇢ 200 community\.membership\.granted \d+ms/);
  });

  it("reports a skipped event (scope not granted) and exits 1", async () => {
    const output = captureOutput();
    const code = await runTrigger(
      {
        event: "community.module.completed",
        member: undefined,
        port: emulator.port,
        help: false,
      },
      { output }
    );
    assert.equal(code, 1);
    assert.match(
      output.text(),
      /skipped community\.module\.completed: Installation is not granted COURSES_READ/
    );
  });

  it("passes the server's error for an unknown member", async () => {
    await assert.rejects(
      triggerEvent({
        event: "community.message.created",
        memberId: "nobody",
        port: emulator.port,
      }),
      (error: unknown) =>
        error instanceof CliError && /No member "nobody"/.test(error.message)
    );
  });

  it("says so when no emulator is running", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    await assert.rejects(
      triggerEvent({ event: "app.installed", port }),
      (error: unknown) =>
        error instanceof CliError &&
        /No emulator is running on http:\/\/127\.0\.0\.1:\d+/.test(
          error.message
        )
    );
  });
});
