/** `planeward init`: writes `planeward.json` for an existing app. */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import { MANIFEST_FILE_NAME, type PlanewardManifest } from "../manifest";
import { parseCommandArgs, rejectPositionals } from "./args";
import { CliError } from "./errors";
import { gitignoreWarning, validateManifest } from "./manifest-file";
import { createOutput, type Output } from "./output";
import { manifestSchemaUrl } from "./package-info";

export type InitOptions = { yes: boolean; help: boolean };

export function parseInitArgs(argv: readonly string[]): InitOptions {
  const { values, positionals } = parseCommandArgs("init", argv, {
    yes: { type: "boolean", short: "y", default: false },
    help: { type: "boolean", short: "h", default: false },
  });
  rejectPositionals(positionals, "init");
  return { yes: values.yes, help: values.help };
}

type PackageJson = { name?: unknown; scripts?: Record<string, unknown> };

const DEFAULT_PORT = 3000;

function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch {
    throw new CliError(`${file} is not valid JSON.`);
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** `--port 3005`, `--port=3005`, `-p 3005` or `PORT=3005` in a dev script. */
export function portFromScript(script: string): number | null {
  const match =
    /(?:^|\s)(?:--port|-p)(?:=|\s+)(\d{2,5})\b/.exec(script) ??
    /\bPORT=(\d{2,5})\b/.exec(script);
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port <= 65_535 ? port : null;
}

export type InferredManifest = {
  manifest: PlanewardManifest;
  /** Assumptions worth telling the user about. */
  notes: string[];
};

export function inferManifest(
  dir: string,
  schemaUrl = manifestSchemaUrl()
): InferredManifest {
  const notes: string[] = [];
  const pkg = readPackageJson(dir);
  if (!pkg) notes.push("No package.json here; used the folder name.");

  const rawName =
    typeof pkg?.name === "string" && pkg.name ? pkg.name : basename(dir);
  const baseName = rawName.replace(/^@[^/]+\//, "");
  let slug = slugify(baseName);
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) {
    notes.push(`Couldn't make a slug from "${baseName}"; used "my-app".`);
    slug = "my-app";
  }
  const name = titleCase(baseName).slice(0, 80) || "My App";

  const devScript = pkg?.scripts?.dev;
  let command = "npm run dev";
  let port = DEFAULT_PORT;
  let protocol = "http";
  if (typeof devScript !== "string" || !devScript.trim()) {
    notes.push(
      `No "dev" script in package.json; set dev.command and dev.url yourself.`
    );
  } else if (/\bplaneward\b/.test(devScript)) {
    notes.push(
      `The "dev" script runs planeward itself; set dev.command to the command that starts the app.`
    );
  } else {
    command = devScript.trim();
    const scriptPort = portFromScript(command);
    if (scriptPort) port = scriptPort;
    else {
      notes.push(
        `The "dev" script sets no --port; assumed ${DEFAULT_PORT}. Add --port to it and dev.url if that's wrong.`
      );
    }
    if (command.includes("--experimental-https")) protocol = "https";
  }

  return {
    manifest: {
      $schema: schemaUrl,
      name,
      slug,
      experiencePath: "/experience",
      dashboardPath: "/dashboard",
      webhookPath: "/api/webhooks/planeward",
      scopes: ["COMMUNITY_MEMBERS_READ"],
      dev: { command, url: `${protocol}://localhost:${port}` },
    },
    notes,
  };
}

/** Asks a yes/no question on the terminal; Enter means yes, EOF means no. */
export function askConfirm(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let answered = false;
    rl.once("close", () => {
      if (!answered) resolve(false);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(/^(y|yes|)$/i.test(answer.trim()));
    });
  });
}

export async function runInit(
  options: InitOptions,
  deps: {
    cwd?: string;
    output?: Output;
    confirm?: (question: string) => Promise<boolean>;
    schemaUrl?: string;
  } = {}
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const output = deps.output ?? createOutput();
  const file = join(cwd, MANIFEST_FILE_NAME);
  if (existsSync(file)) {
    throw new CliError(
      `${MANIFEST_FILE_NAME} already exists in ${cwd}. Edit it, or delete it and run planeward init again.`
    );
  }

  const { manifest, notes } = inferManifest(cwd, deps.schemaUrl);
  const check = validateManifest(manifest);
  if (!check.ok) {
    throw new CliError(
      `Couldn't infer a valid manifest:\n${check.issues.map((issue) => `  - ${issue}`).join("\n")}`
    );
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  output.plain(`\n${json}`);
  for (const note of notes) output.warn(note);

  if (!options.yes) {
    const confirm = deps.confirm ?? ((question) => askConfirm(question));
    if (!(await confirm(`Write ${MANIFEST_FILE_NAME}? (Y/n) `))) {
      output.info("Nothing written.");
      return 1;
    }
  }

  try {
    await writeFile(file, json, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(`${MANIFEST_FILE_NAME} already exists in ${cwd}.`);
    }
    throw error;
  }
  output.info(`Wrote ${file}.`);
  const warning = gitignoreWarning(cwd);
  if (warning) output.warn(warning);
  output.info(
    "Next: check the paths and scopes, then run planeward dev in this folder."
  );
  return 0;
}
