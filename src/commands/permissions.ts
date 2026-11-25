/** `planeward permissions`: reads and checks the app's permissions declaration. */
import { resolve } from "node:path";
import type {
  PlanewardPermissionEntry,
  PlanewardPermissionsResponse,
} from "@planeward/sdk/server";

import { fetchPermissionsDeclaration } from "../emulator/server/permissions";
import { parseCommandArgs, rejectPositionals } from "./args";
import { CliError, UsageError } from "./errors";
import { findManifest, loadManifest } from "./manifest-file";
import { createOutput, type Output } from "./output";

export type PermissionsOptions = {
  url: string | undefined;
  manifest: string | undefined;
  help: boolean;
};

export function parsePermissionsArgs(
  argv: readonly string[]
): PermissionsOptions {
  const { values, positionals } = parseCommandArgs("permissions", argv, {
    url: { type: "string" },
    manifest: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  });
  rejectPositionals(positionals, "permissions");
  if (values.url !== undefined && !/^https?:\/\//.test(values.url)) {
    throw new UsageError(
      `--url must start with "http://" or "https://" (got "${values.url}").`,
      "permissions"
    );
  }
  return { url: values.url, manifest: values.manifest, help: values.help };
}

const DESCRIPTION_WIDTH = 60;

function table(
  entries: readonly PlanewardPermissionEntry[],
  output: Output
): string[] {
  if (entries.length === 0) return [`  ${output.paint("dim", "(none)")}`];
  const rows = [
    ["KEY", "NAME", "DEFAULT", "DESCRIPTION"],
    ...entries.map((entry) => [
      entry.key,
      entry.name,
      entry.default,
      entry.description && entry.description.length > DESCRIPTION_WIDTH
        ? `${entry.description.slice(0, DESCRIPTION_WIDTH - 1)}…`
        : (entry.description ?? ""),
    ]),
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => row[column]!.length))
  );
  return rows.map((row, index) => {
    const line = row
      .map((cell, column) => (column < 3 ? cell.padEnd(widths[column]!) : cell))
      .join("  ")
      .trimEnd();
    return `  ${index === 0 ? output.paint("dim", line) : line}`;
  });
}

/** Both lists as aligned tables. */
export function formatPermissions(
  declaration: PlanewardPermissionsResponse,
  output: Output
): string {
  return [
    "",
    output.paint(
      "bold",
      `Dashboard (${declaration.dashboard.length}): granted per workspace role`
    ),
    ...table(declaration.dashboard, output),
    "",
    output.paint(
      "bold",
      `Community (${declaration.community.length}): granted to @everyone, plans and staff roles`
    ),
    ...table(declaration.community, output),
    "",
  ].join("\n");
}

function appUrl(options: PermissionsOptions, cwd: string): string {
  if (options.url) return options.url;
  const manifestPath = options.manifest
    ? resolve(cwd, options.manifest)
    : findManifest(cwd);
  if (!manifestPath) {
    throw new CliError(
      `No planeward.json in ${cwd} or its parent folders. Pass --url <origin> (for example --url http://localhost:3000), or run "planeward init".`
    );
  }
  return loadManifest(manifestPath, cwd).dev.url;
}

export async function runPermissions(
  options: PermissionsOptions,
  deps: { cwd?: string; output?: Output; fetch?: typeof fetch } = {}
): Promise<number> {
  const output = deps.output ?? createOutput();
  const result = await fetchPermissionsDeclaration(
    appUrl(options, deps.cwd ?? process.cwd()),
    { fetch: deps.fetch }
  );
  switch (result.status) {
    case "ok":
      output.info(`Read ${result.url}`);
      output.plain(formatPermissions(result.declaration, output));
      return 0;
    case "none":
      output.info(
        `No permissions declared: ${result.url} answered 404. Serve one with definePermissions() from @planeward/sdk to add some.`
      );
      return 0;
    case "invalid":
      output.error(
        `${result.url} is invalid (${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}):`
      );
      for (const error of result.errors) output.error(`  - ${error}`);
      return 1;
    case "error":
      throw new CliError(result.error);
  }
}
