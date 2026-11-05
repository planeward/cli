// Refreshes `fixtures/openapi.yaml`, the Planeward OpenAPI spec the emulator
// tests validate mock API responses against.
//
// Source, first match wins:
// 1. `PLANEWARD_OPENAPI` (a file path or an http(s) URL)
// 2. `../../workbench/apps/docs/openapi/v1.yaml` (local Planeward checkout)
// 3. https://docs.planeward.com/openapi.json
//
// `--check` compares the source with the fixture and exits 1 when they
// differ. It never writes.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_SPEC = resolve(root, "../../workbench/apps/docs/openapi/v1.yaml");
const HOSTED_SPEC = "https://docs.planeward.com/openapi.json";
const FIXTURE = resolve(root, "fixtures/openapi.yaml");
const check = process.argv.includes("--check");

function resolveSource() {
  const fromEnv = process.env.PLANEWARD_OPENAPI?.trim();
  if (fromEnv) {
    return /^https?:\/\//.test(fromEnv)
      ? new URL(fromEnv)
      : pathToFileURL(resolve(root, fromEnv));
  }
  if (existsSync(LOCAL_SPEC)) return pathToFileURL(LOCAL_SPEC);
  return new URL(HOSTED_SPEC);
}

async function readSource(source) {
  if (source.protocol === "file:") return readFile(source, "utf8");
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`GET ${source.href} answered ${response.status}.`);
  }
  return response.text();
}

const source = resolveSource();
console.log(`Reading the OpenAPI spec from ${source.href}`);
const text = await readSource(source);
const spec = parse(text);

if (check) {
  const fixture = parse(await readFile(FIXTURE, "utf8"));
  if (!isDeepStrictEqual(spec, fixture)) {
    console.error(
      `${FIXTURE} differs from ${source.href}. Run pnpm update-openapi.`
    );
    process.exit(1);
  }
  console.log(`${FIXTURE} is up to date.`);
} else {
  // The hosted spec is JSON; keep the fixture YAML either way.
  const isJson = text.trimStart().startsWith("{");
  await writeFile(FIXTURE, isJson ? stringify(spec) : text);
  console.log(`Wrote ${FIXTURE}`);
}
