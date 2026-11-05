import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { maskSecret, startDev, type DevSession } from "./dev";
import { CliError } from "./errors";
import {
  captureOutput,
  isAlive,
  tempDir,
  testManifest,
  waitFor,
  writeManifest,
} from "./test-support";

const NODE = JSON.stringify(process.execPath);

const PRINT_ENV = `
const keys = ["PLANEWARD_BASE_URL", "PLANEWARD_APP_ID", "PLANEWARD_APP_SECRET", "PLANEWARD_WEBHOOK_SECRET"];
console.log("ENV " + JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));
setInterval(() => {}, 1000);
`;

const PARENT = `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("PIDS " + process.pid + " " + child.pid);
setInterval(() => {}, 1000);
`;

describe("planeward dev", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  const sessions: DevSession[] = [];

  before(async () => {
    ({ dir, cleanup } = await tempDir());
    await writeFile(join(dir, "print-env.mjs"), PRINT_ENV);
    await writeFile(join(dir, "parent.mjs"), PARENT);
  });

  after(async () => {
    for (const session of sessions) await session.stop();
    await cleanup();
  });

  async function start(command: string, output = captureOutput(), app = true) {
    await writeManifest(
      dir,
      testManifest({ dev: { command, url: "http://127.0.0.1:9" } })
    );
    const session = await startDev({
      cwd: dir,
      port: 0,
      reset: true,
      app,
      manifest: undefined,
      output,
      baseEnv: { ...process.env, PLANEWARD_BASE_URL: "http://wrong.example" },
    });
    sessions.push(session);
    return { session, output };
  }

  it("fails clearly without a manifest", async () => {
    const { dir: empty, cleanup: done } = await tempDir();
    try {
      await assert.rejects(
        startDev({
          cwd: empty,
          port: 0,
          reset: false,
          app: false,
          manifest: undefined,
          output: captureOutput(),
        }),
        (error: unknown) =>
          error instanceof CliError &&
          /No planeward\.json in/.test(error.message)
      );
    } finally {
      await done();
    }
  });

  it("injects the four PLANEWARD_* values into the app, over the parent env", async () => {
    const { session, output } = await start(`${NODE} print-env.mjs`);
    const line = await waitFor(
      () => output.lines().find((entry) => entry.startsWith("[app] ENV ")),
      10_000,
      "the env line"
    );
    const env = JSON.parse(line.slice("[app] ENV ".length));
    assert.deepEqual(env, session.emulator.env);
    assert.equal(env.PLANEWARD_BASE_URL, session.emulator.url);
    assert.match(env.PLANEWARD_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(env.PLANEWARD_APP_ID, "leaderboard-local");

    // The app printed the secrets itself; check the CLI's lines only.
    const banner = output
      .lines()
      .filter((entry) => !entry.startsWith("[app]"))
      .join("\n");
    assert.match(banner, /Emulator {2}http:\/\/127\.0\.0\.1:\d+/);
    assert.match(banner, /App {7}http:\/\/127\.0\.0\.1:9\/experience/);
    assert.match(banner, /Scopes {4}COMMUNITY_MEMBERS_READ/);
    assert.match(banner, /PLANEWARD_APP_SECRET {6}pwa_••••••••/);
    assert.ok(
      !banner.includes(session.emulator.appSecret),
      "app secret is masked"
    );
    assert.ok(
      !banner.includes(session.emulator.webhookSecret),
      "webhook secret is masked"
    );
    assert.match(
      banner,
      /planeward trigger <event> \[--member <id>\] --port \d+/
    );
    await session.stop();
  });

  it("logs API requests, with a hint for a missing scope", async () => {
    const { session, output } = await start("true", captureOutput(), false);
    const headers = {
      authorization: `Bearer ${session.emulator.appSecret}`,
      "x-planeward-installation": session.emulator.installationId,
    };
    await (
      await fetch(`${session.emulator.url}/api/v1/community/members`, {
        headers,
      })
    ).arrayBuffer();
    await (
      await fetch(`${session.emulator.url}/api/v1/events`, { headers })
    ).arrayBuffer();
    await waitFor(
      () => output.text().includes("/api/v1/events"),
      5000,
      "request log"
    );
    assert.match(
      output.text(),
      /→ 200 GET \/api\/v1\/community\/members \d+ms/
    );
    assert.match(
      output.text(),
      /→ 403 GET \/api\/v1\/events \d+ms {2}missing EVENTS_READ: add EVENTS_READ to planeward\.json scopes/
    );
    await session.stop();
  });

  it("stops the app's whole process tree on shutdown", async () => {
    const { session, output } = await start(`${NODE} parent.mjs`);
    const line = await waitFor(
      () => output.lines().find((entry) => entry.startsWith("[app] PIDS ")),
      10_000,
      "the pid line"
    );
    const pids = line.slice("[app] PIDS ".length).split(" ").map(Number);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.ok(isAlive(pid), `${pid} is running`);

    await session.stop();
    await waitFor(
      () => pids.every((pid) => !isAlive(pid)),
      5000,
      "the tree to exit"
    );
    await assert.rejects(fetch(`${session.emulator.url}/__emulator/state`));
  });

  it("keeps the emulator running when the app exits with an error", async () => {
    const { session, output } = await start(`${NODE} -e "process.exit(3)"`);
    await waitFor(
      () => output.text().includes("exited with code 3"),
      10_000,
      "the exit hint"
    );
    assert.match(output.text(), /The emulator is still running at/);
    const response = await fetch(`${session.emulator.url}/__emulator/state`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await session.stop();
  });

  it("asks before running dev.command from a parent folder's manifest", async () => {
    const { dir: parent, cleanup: done } = await tempDir();
    try {
      const child = join(parent, "child");
      await mkdir(child);
      await writeManifest(parent, testManifest());
      const base = {
        cwd: child,
        port: 0,
        reset: true,
        manifest: undefined,
      };

      const refused = captureOutput();
      await assert.rejects(
        startDev({ ...base, app: true, output: refused }),
        (error: unknown) =>
          error instanceof CliError && /Pass --manifest /.test(error.message)
      );
      assert.match(refused.text(), /Using .*planeward\.json from a parent/);

      const questions: string[] = [];
      await assert.rejects(
        startDev({
          ...base,
          app: true,
          output: captureOutput(),
          confirm: async (question) => {
            questions.push(question);
            return false;
          },
        }),
        (error: unknown) =>
          error instanceof CliError && /Not running /.test(error.message)
      );
      assert.match(questions[0] ?? "", /Run its dev\.command \(true\)/);

      const approved = await startDev({
        ...base,
        app: true,
        output: captureOutput(),
        confirm: async () => true,
      });
      sessions.push(approved);
      assert.ok(approved.app);

      const noApp = await startDev({
        ...base,
        app: false,
        output: captureOutput(),
      });
      sessions.push(noApp);
      assert.equal(noApp.app, null);

      const explicit = await startDev({
        ...base,
        app: true,
        manifest: join(parent, "planeward.json"),
        output: captureOutput(),
      });
      sessions.push(explicit);
      assert.ok(explicit.app);
    } finally {
      for (const session of sessions.splice(0)) await session.stop();
      await done();
    }
  });

  it("masks secrets", () => {
    assert.equal(maskSecret("pwa_local_abcdef"), "pwa_••••••••");
  });
});
