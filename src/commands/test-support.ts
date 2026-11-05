/** Helpers shared by the command tests. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlanewardManifest } from "../manifest";
import { createOutput, type Output } from "./output";

export type CapturedOutput = Output & {
  text: () => string;
  lines: () => string[];
};

export function captureOutput(): CapturedOutput {
  let buffer = "";
  const sink = { write: (text: string) => (buffer += text) };
  const output = createOutput({ stdout: sink, stderr: sink, color: false });
  return {
    ...output,
    text: () => buffer,
    lines: () => buffer.split("\n"),
  };
}

export async function tempDir(prefix = "planeward-cli-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testManifest(
  overrides: Partial<PlanewardManifest> = {}
): PlanewardManifest {
  return {
    name: "Leaderboard",
    slug: "leaderboard",
    experiencePath: "/experience",
    scopes: ["COMMUNITY_MEMBERS_READ"],
    // Nothing listens here; no webhookPath, so app.installed is skipped.
    dev: { command: "true", url: "http://127.0.0.1:9" },
    ...overrides,
  };
}

export async function writeManifest(dir: string, manifest: unknown) {
  await writeFile(
    join(dir, "planeward.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2)
  );
}

export async function waitFor<T>(
  check: () => T | null | undefined | false,
  timeoutMs = 10_000,
  label = "condition"
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
