import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDevArgs } from "./dev";
import { UsageError } from "./errors";
import { parseInitArgs } from "./init";
import { main } from "./main";
import { packageVersion } from "./package-info";
import { captureOutput } from "./test-support";
import { parseTriggerArgs } from "./trigger";

const usageError =
  (pattern: RegExp, command: string | null) => (error: unknown) =>
    error instanceof UsageError &&
    error.command === command &&
    pattern.test(error.message);

describe("dev arguments", () => {
  it("has defaults", () => {
    assert.deepEqual(parseDevArgs([]), {
      port: 4600,
      reset: false,
      open: true,
      app: true,
      manifest: undefined,
      help: false,
    });
  });

  it("reads every flag, including --no-open and --no-app", () => {
    assert.deepEqual(
      parseDevArgs([
        "--port",
        "0",
        "--reset",
        "--no-open",
        "--no-app",
        "--manifest=apps/web/planeward.json",
      ]),
      {
        port: 0,
        reset: true,
        open: false,
        app: false,
        manifest: "apps/web/planeward.json",
        help: false,
      }
    );
    assert.equal(parseDevArgs(["-h"]).help, true);
  });

  it("rejects bad ports, unknown flags and stray arguments", () => {
    assert.throws(
      () => parseDevArgs(["--port", "abc"]),
      usageError(/--port must be a number/, "dev")
    );
    assert.throws(
      () => parseDevArgs(["--port", "70000"]),
      usageError(/--port/, "dev")
    );
    assert.throws(() => parseDevArgs(["--port"]), usageError(/--port/, "dev"));
    assert.throws(
      () => parseDevArgs(["--watch"]),
      usageError(/--watch/, "dev")
    );
    assert.throws(
      () => parseDevArgs(["now"]),
      usageError(/Unexpected argument "now"/, "dev")
    );
  });
});

describe("trigger arguments", () => {
  it("takes the event and --member/--port", () => {
    assert.deepEqual(
      parseTriggerArgs([
        "community.message.created",
        "--member",
        "mem_1",
        "--port",
        "4700",
      ]),
      {
        event: "community.message.created",
        member: "mem_1",
        port: 4700,
        help: false,
      }
    );
    assert.equal(parseTriggerArgs([]).event, undefined);
    assert.throws(
      () => parseTriggerArgs(["a", "b"]),
      usageError(/Unexpected argument "b"/, "trigger")
    );
  });
});

describe("init arguments", () => {
  it("takes --yes / -y", () => {
    assert.deepEqual(parseInitArgs([]), { yes: false, help: false });
    assert.deepEqual(parseInitArgs(["-y"]), { yes: true, help: false });
    assert.throws(
      () => parseInitArgs(["--force"]),
      usageError(/--force/, "init")
    );
  });
});

describe("main", () => {
  it("prints the version", async () => {
    const output = captureOutput();
    assert.equal(await main(["--version"], output), 0);
    assert.equal(output.text().trim(), packageVersion());
  });

  it("prints general and per-command help", async () => {
    let output = captureOutput();
    assert.equal(await main(["--help"], output), 0);
    assert.match(output.text(), /Commands\n {2}dev/);

    output = captureOutput();
    assert.equal(await main(["dev", "--help"], output), 0);
    assert.match(output.text(), /--no-app/);

    output = captureOutput();
    assert.equal(await main(["help", "trigger"], output), 0);
    assert.match(output.text(), /community\.message\.created/);

    output = captureOutput();
    assert.equal(await main(["init", "-h"], output), 0);
    assert.match(output.text(), /--yes/);
  });

  it("exits 2 on usage errors with a pointer to --help", async () => {
    let output = captureOutput();
    assert.equal(await main(["deploy"], output), 2);
    assert.match(output.text(), /Unknown command "deploy"/);
    assert.match(output.text(), /Run "planeward --help"/);

    output = captureOutput();
    assert.equal(await main(["trigger", "nope.event"], output), 2);
    assert.match(output.text(), /Unknown event "nope\.event"/);
    assert.match(output.text(), /Run "planeward trigger --help"/);

    output = captureOutput();
    assert.equal(await main([], output), 2);
  });
});
