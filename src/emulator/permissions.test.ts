import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanewardPermissionsResponse } from "@planeward/sdk";

import type { CommunityGrantValue, PermissionGrants } from "../manifest";
import {
  normalizeGrants,
  resolveCommunityKey,
  resolvePermissions,
  setCommunityGrant,
  setDashboardGrant,
} from "./permissions";

describe("resolveCommunityKey", () => {
  type Case = [
    string,
    boolean,
    CommunityGrantValue | undefined,
    (CommunityGrantValue | undefined)[],
    boolean,
  ];
  const cases: Case[] = [
    ["the default when nothing is set", true, undefined, [], true],
    [
      "the default off when nothing is set",
      false,
      undefined,
      [undefined],
      false,
    ],
    ["@everyone over the default", true, "off", [], false],
    ["@everyone on over a default off", false, "on", [], true],
    ["a plan over @everyone", false, "off", ["on"], true],
    ["a plan off over @everyone on", true, "on", ["off"], false],
    ["any On across plans beats Off", false, "off", ["off", "on"], true],
    ["unset plans leave @everyone", false, "on", [undefined, undefined], true],
  ];
  for (const [name, defaultOn, everyone, plans, expected] of cases) {
    it(name, () => {
      assert.equal(
        resolveCommunityKey({ defaultOn, everyone, plans }),
        expected
      );
    });
  }
});

describe("resolvePermissions", () => {
  const declaration: PlanewardPermissionsResponse = {
    dashboard: [
      { key: "reports.view", name: "View reports", default: "on" },
      { key: "reports.export", name: "Export reports", default: "off" },
    ],
    community: [
      { key: "posts.create", name: "Create posts", default: "on" },
      { key: "posts.moderate", name: "Moderate posts", default: "off" },
    ],
  };
  const grants: PermissionGrants = {
    everyone: { "posts.create": "off" },
    plans: { plan_pro: { "posts.create": "on", "posts.moderate": "on" } },
    dashboard: { "reports.view": false, "reports.export": true },
  };

  it("gives each viewer the keys production would", () => {
    const resolve = (
      view: "experience" | "dashboard",
      role: "member" | "admin",
      planId: string | null
    ) => resolvePermissions(declaration, grants, { view, role, planId });
    assert.deepEqual(resolve("experience", "member", null), []);
    assert.deepEqual(resolve("experience", "member", "plan_pro"), [
      "posts.create",
      "posts.moderate",
    ]);
    // Admins get nothing automatically and have no plan.
    assert.deepEqual(resolve("experience", "admin", "plan_pro"), []);
    assert.deepEqual(resolve("dashboard", "admin", "plan_pro"), [
      "reports.export",
    ]);
    assert.deepEqual(
      resolvePermissions(
        declaration,
        {},
        {
          view: "dashboard",
          role: "admin",
          planId: null,
        }
      ),
      ["reports.view"]
    );
    assert.deepEqual(
      resolvePermissions(null, grants, {
        view: "experience",
        role: "member",
        planId: "plan_pro",
      }),
      []
    );
  });
});

describe("grant edits", () => {
  it("sets, unsets and prunes empty maps", () => {
    let grants = setCommunityGrant({}, { kind: "everyone" }, "a.b", "on");
    grants = setCommunityGrant(
      grants,
      { kind: "plan", planId: "plan_pro" },
      "a.b",
      "off"
    );
    grants = setDashboardGrant(grants, "c.d", false);
    assert.deepEqual(grants, {
      everyone: { "a.b": "on" },
      plans: { plan_pro: { "a.b": "off" } },
      dashboard: { "c.d": false },
    });
    grants = setCommunityGrant(grants, { kind: "everyone" }, "a.b", undefined);
    grants = setCommunityGrant(
      grants,
      { kind: "plan", planId: "plan_pro" },
      "a.b",
      undefined
    );
    assert.deepEqual(grants, { dashboard: { "c.d": false } });
    assert.deepEqual(
      normalizeGrants({ everyone: {}, plans: { x: {} }, dashboard: {} }),
      {}
    );
  });
});
