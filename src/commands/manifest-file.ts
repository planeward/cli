/**
 * Finding, parsing and validating `planeward.json`. The Zod schema follows
 * the same rules as `schema/planeward.schema.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

import {
  APP_GRANTABLE_SCOPES,
  MANIFEST_FILE_NAME,
  type PlanewardManifest,
} from "../manifest";
import { CliError } from "./errors";

const path = (label: string) =>
  z
    .string({ error: `${label} must be a string.` })
    .regex(/^\//, { error: `${label} must start with "/".` });

export const manifestSchema = z.strictObject(
  {
    $schema: z.string().optional(),
    name: z
      .string({ error: "name must be a string." })
      .min(1, { error: "name can't be empty." })
      .max(80, { error: "name must be at most 80 characters." }),
    slug: z
      .string({ error: "slug must be a string." })
      .regex(/^[a-z0-9][a-z0-9-]{1,47}$/, {
        error:
          "slug must be 2–48 lowercase letters, digits or dashes, starting with a letter or digit.",
      }),
    experiencePath: path("experiencePath"),
    dashboardPath: path("dashboardPath").optional(),
    webhookPath: path("webhookPath").optional(),
    scopes: z
      .array(
        z.enum(APP_GRANTABLE_SCOPES, {
          error: (issue) =>
            `${JSON.stringify(issue.input)} is not an app scope. Use one of: ${APP_GRANTABLE_SCOPES.join(", ")}.`,
        }),
        { error: "scopes must be an array." }
      )
      .superRefine((scopes, ctx) => {
        scopes.forEach((scope, index) => {
          if (scopes.indexOf(scope) !== index) {
            ctx.addIssue({
              code: "custom",
              path: [index],
              message: `${scope} is listed twice.`,
            });
          }
        });
      }),
    dev: z.strictObject(
      {
        command: z
          .string({ error: "dev.command must be a string." })
          .min(1, { error: "dev.command can't be empty." }),
        url: z
          .string({ error: "dev.url must be a string." })
          .regex(/^https?:\/\//, {
            error: 'dev.url must start with "http://" or "https://".',
          })
          .refine((value) => URL.canParse(value), {
            error: "dev.url is not a valid URL.",
          }),
      },
      { error: "dev must be an object with command and url." }
    ),
  },
  { error: "must be a JSON object." }
) satisfies z.ZodType<PlanewardManifest>;

/** `scopes[1]`, `dev.url`, or `(root)`. */
function formatPath(segments: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out || "(root)";
}

function formatIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const prefix = issue.path.length ? `${formatPath(issue.path)}: ` : "";
    const keys = issue.keys.map((key) => `"${key}"`).join(", ");
    return `${prefix}unknown field${issue.keys.length > 1 ? "s" : ""} ${keys}.`;
  }
  if (issue.code === "invalid_type" && issue.input === undefined) {
    return `${formatPath(issue.path)}: required.`;
  }
  return `${formatPath(issue.path)}: ${issue.message}`;
}

/** Thrown for a missing, unreadable or invalid manifest; `message` lists every problem. */
export class ManifestError extends CliError {
  readonly issues: string[];

  constructor(file: string, issues: string[]) {
    super(
      `${file} is invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`
    );
    this.issues = issues;
  }
}

/** Validates parsed JSON; returns the manifest or the list of problems. */
export function validateManifest(
  value: unknown
): { ok: true; manifest: PlanewardManifest } | { ok: false; issues: string[] } {
  const result = manifestSchema.safeParse(value, { reportInput: true });
  if (result.success) return { ok: true, manifest: result.data };
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}

/**
 * `planeward.json` in `startDir` or the nearest ancestor that has one. The
 * search stops at the git root (the first folder with `.git`) or the home
 * folder, whichever comes first, so a manifest above the project is never
 * picked up.
 */
export function findManifest(
  startDir: string,
  options: { home?: string } = {}
): string | null {
  const home = resolve(options.home ?? homedir());
  let dir = resolve(startDir);
  for (;;) {
    const file = join(dir, MANIFEST_FILE_NAME);
    if (existsSync(file)) return file;
    if (dir === home || existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadManifest(
  file: string,
  cwd = process.cwd()
): PlanewardManifest {
  const label = relative(cwd, file) || file;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new CliError(
      `Can't read ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(label, [
      `not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    ]);
  }
  const result = validateManifest(json);
  if (!result.ok) throw new ManifestError(label, result.issues);
  return result.manifest;
}

const PLANEWARD_IGNORE_PATTERNS = new Set([
  ".planeward",
  ".planeward/",
  "/.planeward",
  "/.planeward/",
  "**/.planeward",
  "**/.planeward/",
  ".planeward/*",
  ".planeward/**",
]);

function ignoresPlaneward(gitignore: string): boolean {
  if (!existsSync(gitignore)) return false;
  return readFileSync(gitignore, "utf8")
    .split(/\r?\n/)
    .some((line) => PLANEWARD_IGNORE_PATTERNS.has(line.trim()));
}

/** The nearest ancestor with a `.git` entry, or null outside a repo. */
function repoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A warning when neither the `.gitignore` next to the manifest nor the repo
 * root's ignores `.planeward/` (it holds the local signing key and secrets).
 * The folder ignores itself with its own `.gitignore`, so this only asks to
 * make that explicit.
 */
export function gitignoreWarning(manifestDir: string): string | null {
  const candidates = [join(manifestDir, ".gitignore")];
  const root = repoRoot(manifestDir);
  if (root && root !== resolve(manifestDir)) {
    candidates.push(join(root, ".gitignore"));
  }
  if (candidates.some(ignoresPlaneward)) return null;
  return `.planeward/ is not in .gitignore. It holds the local signing key and secrets and ignores itself, but adding ".planeward/" to ${candidates[0]} makes that explicit.`;
}
