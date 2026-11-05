import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST_SCHEMA_PATH } from "../manifest";

type PackageJson = { name?: string; version?: string };

let cachedRoot: string | null | undefined;

/** The `planeward` package root (`dist/..` or `src/commands/../..`). */
export function packageRoot(): string {
  if (cachedRoot === undefined) {
    cachedRoot = null;
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const file = join(dir, "package.json");
      if (existsSync(file)) {
        try {
          const json = JSON.parse(readFileSync(file, "utf8")) as PackageJson;
          if (json.name === "planeward") {
            cachedRoot = dir;
            break;
          }
        } catch {
          // Keep walking.
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (!cachedRoot) throw new Error("Can't find the planeward package root.");
  return cachedRoot;
}

export function packageVersion(): string {
  const json = JSON.parse(
    readFileSync(join(packageRoot(), "package.json"), "utf8")
  ) as PackageJson;
  return json.version ?? "0.0.0";
}

/**
 * URL of the `planeward.json` JSON Schema shipped with this version, served
 * from npm by unpkg. Written to `$schema` by `planeward init`.
 */
export function manifestSchemaUrl(version = packageVersion()): string {
  return `https://unpkg.com/planeward@${version}/${MANIFEST_SCHEMA_PATH}`;
}
