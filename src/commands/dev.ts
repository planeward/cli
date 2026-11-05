/** `planeward dev`: emulator + the app's dev server with the PLANEWARD_* env. */
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import open from "open";

import { EMULATOR_DEFAULT_PORT } from "../emulator/contract";
import { startEmulator, type RunningEmulator } from "../emulator/server/index";
import { KEYS_FILE_NAME } from "../emulator/server/keys";
import type { PlanewardManifest } from "../manifest";
import { spawnApp, type AppProcess } from "./app-process";
import { parseCommandArgs, parsePort, rejectPositionals } from "./args";
import { followEmulatorLog } from "./emulator-log";
import { CliError } from "./errors";
import { findManifest, gitignoreWarning, loadManifest } from "./manifest-file";
import { createOutput, type Output } from "./output";

export const STATE_DIR_NAME = ".planeward";

export type DevOptions = {
  port: number;
  reset: boolean;
  open: boolean;
  app: boolean;
  manifest: string | undefined;
  help: boolean;
};

export function parseDevArgs(argv: readonly string[]): DevOptions {
  const { values, positionals } = parseCommandArgs("dev", argv, {
    port: { type: "string" },
    reset: { type: "boolean", default: false },
    open: { type: "boolean", default: true },
    app: { type: "boolean", default: true },
    manifest: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  });
  rejectPositionals(positionals, "dev");
  return {
    port: parsePort(values.port, EMULATOR_DEFAULT_PORT, "dev"),
    reset: values.reset,
    open: values.open,
    app: values.app,
    manifest: values.manifest,
    help: values.help,
  };
}

/** Shows the first 4 characters only. */
export function maskSecret(value: string): string {
  return `${value.slice(0, 4)}${"•".repeat(8)}`;
}

const joinUrl = (origin: string, path: string) =>
  `${origin.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export function formatBanner(input: {
  manifest: PlanewardManifest;
  manifestDir: string;
  emulator: RunningEmulator;
  appStarted: boolean;
  interactive: boolean;
  output: Output;
}): string {
  const { manifest, emulator, output } = input;
  const label = (text: string) => output.paint("bold", text.padEnd(10));
  const env = emulator.env;
  const envRows = (
    [
      ["PLANEWARD_BASE_URL", env.PLANEWARD_BASE_URL],
      ["PLANEWARD_APP_ID", env.PLANEWARD_APP_ID],
      ["PLANEWARD_APP_SECRET", maskSecret(env.PLANEWARD_APP_SECRET)],
      ["PLANEWARD_WEBHOOK_SECRET", maskSecret(env.PLANEWARD_WEBHOOK_SECRET)],
    ] as const
  ).map(
    ([name, value], index) =>
      `  ${index === 0 ? label("Env") : " ".repeat(10)}${name.padEnd(26)}${value}`
  );
  const portFlag =
    emulator.port === EMULATOR_DEFAULT_PORT ? "" : ` --port ${emulator.port}`;
  const keysFile = join(
    relative(process.cwd(), input.manifestDir) || ".",
    STATE_DIR_NAME,
    KEYS_FILE_NAME
  );
  const lines = [
    "",
    `  ${output.paint("bold", manifest.name)} on the local Planeward emulator`,
    "",
    `  ${label("Emulator")}${output.paint("cyan", emulator.url)}`,
    `  ${label("App")}${joinUrl(manifest.dev.url, manifest.experiencePath)}${
      input.appStarted
        ? output.paint("dim", `  (${manifest.dev.command})`)
        : output.paint("dim", "  (not started: --no-app)")
    }`,
    ...(manifest.webhookPath
      ? [
          `  ${label("Webhooks")}${joinUrl(manifest.dev.url, manifest.webhookPath)}`,
        ]
      : []),
    `  ${label("Scopes")}${manifest.scopes.length ? manifest.scopes.join(", ") : output.paint("dim", "(none)")}`,
    ...envRows,
    ...(input.appStarted
      ? []
      : [
          `  ${" ".repeat(10)}${output.paint("dim", `Start your app with these; the secrets are in ${keysFile}.`)}`,
        ]),
    `  ${label("Trigger")}planeward trigger <event> [--member <id>]${portFlag}`,
    `  ${label("Reset")}${input.interactive ? "press r, or restart with --reset" : "restart with --reset"}`,
    `  ${label("Stop")}Ctrl-C`,
    "",
  ];
  return lines.join("\n");
}

export type DevSession = {
  manifestPath: string;
  manifest: PlanewardManifest;
  emulator: RunningEmulator;
  app: AppProcess | null;
  /** Reseeds the emulator state. */
  reset: () => void;
  /** Stops the app's process tree, then the emulator. */
  stop: () => Promise<void>;
};

export type StartDevOptions = Omit<DevOptions, "help" | "open"> & {
  cwd: string;
  output: Output;
  interactive?: boolean;
  /**
   * Asks before running `dev.command` from a manifest found in a parent
   * folder. Without it (no TTY), that needs `--manifest` or `--no-app`.
   */
  confirm?: (question: string) => Promise<boolean>;
  /** Overrides the parent environment for the app (tests). */
  baseEnv?: NodeJS.ProcessEnv;
  uiDir?: string;
};

export async function startDev(options: StartDevOptions): Promise<DevSession> {
  const { output } = options;
  const manifestPath = options.manifest
    ? resolve(options.cwd, options.manifest)
    : findManifest(options.cwd);
  if (!manifestPath) {
    throw new CliError(
      `No planeward.json in ${options.cwd} or its parent folders. Run "planeward init" in your app folder to create one.`
    );
  }
  const manifest = loadManifest(manifestPath, options.cwd);
  const manifestDir = dirname(manifestPath);

  // `dev.command` runs through the shell: don't run one from a parent
  // folder's manifest without the user saying so.
  if (
    options.app &&
    !options.manifest &&
    manifestDir !== resolve(options.cwd)
  ) {
    output.info(`Using ${manifestPath} from a parent folder.`);
    const approved = options.confirm
      ? await options.confirm(
          `Run its dev.command (${manifest.dev.command}) in ${manifestDir}? [y/N] `
        )
      : false;
    if (!approved) {
      throw new CliError(
        options.confirm
          ? `Not running ${manifestPath}'s dev.command. Pass --manifest ${manifestPath} to use it, or --no-app.`
          : `${manifestPath} is not in the current folder. Pass --manifest ${manifestPath} to run its dev.command, or --no-app.`
      );
    }
  }

  const warning = gitignoreWarning(manifestDir);
  if (warning) output.warn(warning);

  let emulator: RunningEmulator;
  try {
    emulator = await startEmulator({
      manifest,
      stateDir: join(manifestDir, STATE_DIR_NAME),
      reset: options.reset,
      port: options.port,
      uiDir: options.uiDir,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new CliError(
        `Port ${options.port} is in use (another planeward dev?). Stop it or pass --port <n> (0 picks a free port).`
      );
    }
    throw error;
  }

  const logAbort = new AbortController();
  await followEmulatorLog({
    url: emulator.url,
    output,
    signal: logAbort.signal,
  }).catch((error: unknown) => {
    if (!logAbort.signal.aborted) {
      output.warn(
        `Couldn't follow the emulator log: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  output.plain(
    formatBanner({
      manifest,
      manifestDir,
      emulator,
      appStarted: options.app,
      interactive: options.interactive ?? false,
      output,
    })
  );
  if (emulator.fresh && manifest.webhookPath) {
    output.info(
      "Fresh state: app.installed is sent once the app answers (up to 60 s)."
    );
  }

  let stopping = false;
  const app = options.app
    ? spawnApp({
        command: manifest.dev.command,
        cwd: manifestDir,
        env: emulator.env,
        output,
        baseEnv: options.baseEnv,
      })
    : null;

  void app?.exited.then(({ code, signal }) => {
    if (stopping) return;
    const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
    (code === 0 ? output.warn : output.error)(`The app ${how}.`);
    output.info(
      `The emulator is still running at ${emulator.url}. Fix the app and restart planeward dev, or run it yourself and use planeward dev --no-app.`
    );
  });

  return {
    manifestPath,
    manifest,
    emulator,
    app,
    reset() {
      emulator.instance.store.reset();
      output.info("Emulator state reset to the seed data.");
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      await app?.stop();
      logAbort.abort();
      await emulator.close();
    },
  };
}

/** One `[y/N]` question on the terminal; anything but y/yes is no. */
async function askYesNo(
  stdin: NodeJS.ReadStream,
  question: string
): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await prompt.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export type RunDevDeps = {
  cwd?: string;
  output?: Output;
  stdin?: NodeJS.ReadStream;
};

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  ...(process.platform === "win32" ? (["SIGBREAK"] as NodeJS.Signals[]) : []),
];

/** Runs until Ctrl-C / SIGTERM; resolves with the exit code. */
export async function runDev(
  options: DevOptions,
  deps: RunDevDeps = {}
): Promise<number> {
  const output = deps.output ?? createOutput();
  const stdin = deps.stdin ?? process.stdin;
  const interactive = Boolean(stdin.isTTY);

  const session = await startDev({
    ...options,
    cwd: deps.cwd ?? process.cwd(),
    output,
    interactive,
    confirm: interactive ? (question) => askYesNo(stdin, question) : undefined,
  });

  if (options.open) {
    open(session.emulator.url).catch((error: unknown) =>
      output.warn(
        `Couldn't open a browser (${error instanceof Error ? error.message : String(error)}). Open ${session.emulator.url} yourself.`
      )
    );
  }

  return new Promise<number>((resolve) => {
    let shuttingDown = false;

    const onKey = (key: string) => {
      if (key === "\u0003") shutdown("SIGINT");
      else if (key === "r" || key === "R") session.reset();
    };

    const cleanup = () => {
      for (const signal of SHUTDOWN_SIGNALS) process.off(signal, shutdown);
      if (interactive) {
        stdin.off("data", onKey);
        stdin.setRawMode(false);
        stdin.pause();
      }
    };

    function shutdown(signal: NodeJS.Signals) {
      if (shuttingDown) {
        output.warn(`Got ${signal} again; exiting now.`);
        process.exit(1);
      }
      shuttingDown = true;
      output.info("Stopping…");
      session
        .stop()
        .catch((error: unknown) =>
          output.error(
            `Shutdown error: ${error instanceof Error ? error.message : String(error)}`
          )
        )
        .finally(() => {
          cleanup();
          output.info("Stopped.");
          resolve(0);
        });
    }

    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, shutdown);
    if (interactive) {
      stdin.setRawMode(true);
      stdin.setEncoding("utf8");
      stdin.on("data", onKey);
      stdin.resume();
    }
  });
}
