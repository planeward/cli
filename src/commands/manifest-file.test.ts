import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { MANIFEST_SCHEMA_PATH } from "../manifest";
import {
  findManifest,
  gitignoreWarning,
  loadManifest,
  ManifestError,
  validateManifest,
} from "./manifest-file";
import { tempDir, testManifest, writeManifest } from "./test-support";

const issuesOf = (value: unknown) => {
  const result = validateManifest(value);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
};

describe("manifest discovery", () => {
  let root: string;
  let cleanup: () => Promise<void>;

  before(async () => {
    ({ dir: root, cleanup } = await tempDir());
  });
  after(() => cleanup());

  it("finds planeward.json in the folder or the nearest ancestor", async () => {
    const app = join(root, "apps", "web");
    const nested = join(app, "src", "lib");
    await mkdir(nested, { recursive: true });
    assert.equal(findManifest(nested), null);

    await writeManifest(app, testManifest());
    assert.equal(findManifest(nested), join(app, "planeward.json"));
    assert.equal(findManifest(app), join(app, "planeward.json"));
  });

  it("stops searching at the git root or the home folder", async () => {
    const outer = join(root, "outer");
    const repo = join(outer, "repo");
    const nested = join(repo, "packages", "app");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeManifest(outer, testManifest());
    assert.equal(findManifest(nested), null, "not above the git root");

    await writeManifest(repo, testManifest());
    assert.equal(findManifest(nested), join(repo, "planeward.json"));

    const home = join(root, "home");
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    await writeManifest(root, testManifest());
    assert.equal(findManifest(project, { home }), null, "not above home");
    await writeManifest(home, testManifest());
    assert.equal(findManifest(project, { home }), join(home, "planeward.json"));
  });

  it("loads a valid manifest", async () => {
    const app = join(root, "apps", "web");
    assert.equal(loadManifest(join(app, "planeward.json")).slug, "leaderboard");
  });

  it("reports invalid JSON with the file name", async () => {
    const dir = join(root, "broken");
    await mkdir(dir);
    await writeManifest(dir, "{ nope");
    assert.throws(
      () => loadManifest(join(dir, "planeward.json"), root),
      (error: unknown) =>
        error instanceof ManifestError &&
        /broken\/planeward\.json is invalid/.test(error.message) &&
        /not valid JSON/.test(error.message)
    );
  });

  it("warns when .planeward is not gitignored, here or at the repo root", async () => {
    const repo = join(root, "repo");
    const app = join(repo, "apps", "web");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(app, { recursive: true });
    assert.match(
      gitignoreWarning(app) ?? "",
      /\.planeward\/ is not in \.gitignore/
    );

    await writeFile(join(repo, ".gitignore"), "node_modules\n.planeward/\n");
    assert.equal(gitignoreWarning(app), null);

    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, ".gitignore"), "/.planeward\n");
    assert.equal(gitignoreWarning(other), null);
  });
});

describe("manifest validation", () => {
  it("names the path of each problem", () => {
    const issues = issuesOf({
      ...testManifest(),
      slug: "Bad Slug",
      experiencePath: "experience",
      scopes: ["COMMUNITY_MEMBERS_READ", "ADMIN", "COMMUNITY_MEMBERS_READ"],
      dev: { command: "", url: "localhost:3000", port: 3 },
      extra: true,
    });
    const text = issues.join("\n");
    assert.match(text, /^slug: slug must be/m);
    assert.match(text, /^experiencePath: experiencePath must start with "\/"/m);
    assert.match(
      text,
      /^scopes\[1\]: "ADMIN" is not an app scope\. Use one of: COMMUNITY_MEMBERS_READ/m
    );
    assert.match(text, /^dev\.command: dev\.command can't be empty\./m);
    assert.match(text, /^dev\.url: dev\.url must start with/m);
    assert.match(text, /^dev: unknown field "port"\./m);
    assert.match(text, /^unknown field "extra"\./m);
  });

  it("rejects duplicate scopes", () => {
    assert.deepEqual(
      issuesOf({ ...testManifest(), scopes: ["EVENTS_READ", "EVENTS_READ"] }),
      ["scopes[1]: EVENTS_READ is listed twice."]
    );
  });

  it("reports missing required fields", () => {
    const text = issuesOf({ name: "x" }).join("\n");
    for (const field of ["slug", "experiencePath", "scopes", "dev"]) {
      assert.match(text, new RegExp(`^${field}: required\\.`, "m"));
    }
    assert.match(
      issuesOf([]).join("\n"),
      /^\(root\): must be a JSON object\./m
    );
  });

  it("agrees with the shipped JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(`../../${MANIFEST_SCHEMA_PATH}`, import.meta.url),
        "utf8"
      )
    );
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(schema);
    const samples: unknown[] = [
      testManifest(),
      testManifest({
        $schema: "./x.json",
        dashboardPath: "/d",
        webhookPath: "/w",
      }),
      { ...testManifest(), scopes: ["NOPE"] },
      { ...testManifest(), scopes: ["EVENTS_READ", "EVENTS_READ"] },
      { ...testManifest(), slug: "a" },
      { ...testManifest(), name: "" },
      { ...testManifest(), webhookPath: "hooks" },
      { ...testManifest(), dev: { command: "x" } },
      { ...testManifest(), dev: { command: "x", url: "ftp://x" } },
      { ...testManifest(), other: 1 },
    ];
    for (const sample of samples) {
      assert.equal(
        validateManifest(sample).ok,
        validate(sample),
        `disagree on ${JSON.stringify(sample)}`
      );
    }
  });
});
