import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkScopes, grantsScope, orderedScopes } from "./scopes";

describe("scopes", () => {
  it("lets COURSE_PROGRESS_WRITE imply COURSES_READ, and nothing else", () => {
    assert.equal(
      grantsScope(new Set(["COURSE_PROGRESS_WRITE"]), "COURSES_READ"),
      true
    );
    assert.equal(
      grantsScope(
        new Set(["COMMUNITY_MESSAGES_WRITE"]),
        "COMMUNITY_MESSAGES_READ"
      ),
      false
    );
  });

  it("reports the first missing scope", () => {
    assert.deepEqual(checkScopes(new Set(), { scopes: ["EVENTS_READ"] }), {
      ok: false,
      scope: "EVENTS_READ",
      missingScope: "EVENTS_READ",
    });
    assert.deepEqual(
      checkScopes(new Set(["COMMUNITY_MESSAGES_WRITE"]), {
        scopes: ["COMMUNITY_MESSAGES_READ", "COMMUNITY_MESSAGES_WRITE"],
        anyOf: true,
      }),
      { ok: true, scope: "COMMUNITY_MESSAGES_WRITE" }
    );
  });

  it("orders scopes like Planeward permission bits", () => {
    assert.deepEqual(
      orderedScopes(["COMMUNITY_BADGES_WRITE", "COMMUNITY_MEMBERS_READ"]),
      ["COMMUNITY_MEMBERS_READ", "COMMUNITY_BADGES_WRITE"]
    );
  });
});
