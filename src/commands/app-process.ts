/**
 * Runs `dev.command` through the shell in its own process group, prefixes its
 * output, and stops the whole tree (shell, package manager, dev server and
 * its workers) on shutdown.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

import { createLineSplitter, type Output } from "./output";

const IS_WINDOWS = process.platform === "win32";
const STOP_GRACE_MS = 5000;

export type AppExit = { code: number | null; signal: NodeJS.Signals | null };

export type AppProcess = {
  pid: number | undefined;
  /** Resolves when the shell process exits. */
  exited: Promise<AppExit>;
  /** SIGTERM to the process tree, SIGKILL after a grace period; resolves when it's gone. */
  stop: () => Promise<void>;
};

export type SpawnAppOptions = {
  command: string;
  cwd: string;
  /** Merged over `process.env` (these win). */
  env: Record<string, string>;
  output: Output;
  /** Overrides the parent environment (tests). */
  baseEnv?: NodeJS.ProcessEnv;
};

/** `<dir>/node_modules/.bin` for `dir` and every ancestor, nearest first (like `npm run`). */
function binDirs(start: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(start);
  for (;;) {
    const bin = join(dir, "node_modules", ".bin");
    if (existsSync(bin)) dirs.push(bin);
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/** `process.env` + local `.bin` dirs on PATH + the injected variables. */
export function appEnv(
  cwd: string,
  injected: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Windows env keys are case-insensitive; keep whichever spelling exists.
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [...binDirs(cwd), env[pathKey]]
    .filter(Boolean)
    .join(delimiter);
  if (env.FORCE_COLOR === undefined && process.stdout.isTTY) {
    // Output is piped through the CLI; keep the dev server's colors.
    env.FORCE_COLOR = "1";
  }
  return { ...env, ...injected };
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(IS_WINDOWS ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    // No process groups: taskkill walks the tree. It only force-kills reliably.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function spawnApp(options: SpawnAppOptions): AppProcess {
  const child = spawn(options.command, {
    cwd: options.cwd,
    env: appEnv(options.cwd, options.env, options.baseEnv),
    shell: true,
    // Own process group (POSIX), so the whole tree can be signalled at once
    // and a terminal Ctrl-C reaches the CLI first.
    detached: !IS_WINDOWS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  for (const stream of ["stdout", "stderr"] as const) {
    const splitter = createLineSplitter((line) =>
      options.output.app(line, stream)
    );
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (chunk: string) => splitter.push(chunk));
    child[stream]?.on("end", () => splitter.flush());
  }

  const exited = new Promise<AppExit>((resolve) => {
    child.once("error", (error) => {
      options.output.error(`Couldn't start the app: ${error.message}`);
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // Last resort if the CLI exits without `stop` (uncaught error).
  const killOnExit = () => signalTree(child, "SIGKILL");
  process.once("exit", killOnExit);

  let stopping: Promise<void> | null = null;

  return {
    pid: child.pid,
    exited,
    stop() {
      stopping ??= (async () => {
        const pid = child.pid;
        if (pid !== undefined) {
          signalTree(child, "SIGTERM");
          const deadline = Date.now() + STOP_GRACE_MS;
          while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
          if (groupAlive(pid)) signalTree(child, "SIGKILL");
          while (groupAlive(pid) && Date.now() < deadline + 1000) {
            await sleep(50);
          }
        }
        await Promise.race([exited, sleep(1000)]);
        process.removeListener("exit", killOnExit);
      })();
      return stopping;
    },
  };
}
