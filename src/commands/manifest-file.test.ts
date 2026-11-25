import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { MANIFEST_SCHEMA_PATH, type PermissionGrants } from "../manifest";
import {
  findManifest,
  gitignoreWarning,
  loadManifest,
  ManifestError,
  saveManifestGrants,
  validateManifest,
} from "./manifest-file";
import { tempDir, testManifest, writeManifest } from "./test-support";

const dev = testManifest().dev;
const PLANS = [{ id: "plan_pro", name: "Pro" }];
const GRANTS = {
  everyone: { "posts.create": "on" },
  plans: { plan_pro: { "posts.moderate": "on", "posts.create": "off" } },
  dashboard: { "reports.export": true },
};

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

  it("saves grants to dev.grants and keeps the rest of the file", async () => {
    const dir = join(root, "grants");
    await mkdir(dir);
    const manifest = { ...testManifest(), dev: { ...dev, plans: PLANS } };
    await writeManifest(dir, manifest);
    const file = join(dir, "planeward.json");

    await saveManifestGrants(file, GRANTS as PermissionGrants);
    assert.deepEqual(loadManifest(file), {
      ...manifest,
      dev: { ...manifest.dev, grants: GRANTS },
    });

    await saveManifestGrants(file, {});
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), manifest);
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

  it("accepts dev.plans and dev.grants, and names their problems", () => {
    assert.equal(
      validateManifest({
        ...testManifest(),
        dev: { ...dev, plans: PLANS, grants: GRANTS },
      }).ok,
      true
    );
    assert.deepEqual(
      issuesOf({
        ...testManifest(),
        dev: {
          ...dev,
          plans: [...PLANS, { id: "plan_pro", name: "Again" }],
          grants: {
            everyone: { posts: "on" },
            dashboard: { "reports.export": "on" },
          },
        },
      }),
      [
        "dev.plans[1].id: plan_pro is listed twice.",
        'dev.grants.everyone.posts: "posts" is not a permission key (dotted lowercase, like "posts.moderate").',
        "dev.grants.dashboard.reports.export: a dashboard grant is true or false.",
      ]
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
      { ...testManifest(), dev: { ...dev, plans: PLANS, grants: GRANTS } },
      { ...testManifest(), dev: { ...dev, plans: [{ id: "a b", name: "x" }] } },
      { ...testManifest(), dev: { ...dev, plans: [{ id: "a", name: "" }] } },
      { ...testManifest(), dev: { ...dev, grants: { everyone: { x: "on" } } } },
      {
        ...testManifest(),
        dev: { ...dev, grants: { everyone: { "a.b": "yes" } } },
      },
      {
        ...testManifest(),
        dev: { ...dev, grants: { dashboard: { "a.b": 1 } } },
      },
      {
        ...testManifest(),
        dev: { ...dev, grants: { plans: { "bad id": {} } } },
      },
      { ...testManifest(), dev: { ...dev, grants: { roles: {} } } },
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
