import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { APP_GRANTABLE_SCOPES, MANIFEST_SCHEMA_PATH } from "./manifest";

describe("manifest JSON Schema", () => {
  it("lists exactly the app-grantable scopes", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(`../${MANIFEST_SCHEMA_PATH}`, import.meta.url),
        "utf8"
      )
    );

    assert.deepEqual(schema.properties.scopes.items.enum, [
      ...APP_GRANTABLE_SCOPES,
    ]);
  });
});
