/**
 * Test-only: validates mock API responses against the Planeward OpenAPI spec
 * (`apps/docs/openapi/v1.yaml`) with Ajv. The spec is `openapi: 3.1.0` but
 * uses 3.0-style `nullable: true`; that is rewritten to `type: [T, "null"]`
 * before compiling. Set `PLANEWARD_OPENAPI` to point at another copy.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import addFormats from "ajv-formats";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { parse } from "yaml";

export const DEFAULT_OPENAPI_PATH = join(
  homedir(),
  "workspaces/workbench/apps/docs/openapi/v1.yaml"
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const SPEC_ID = "planeward-openapi.json";

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `nullable: true` → add `"null"` to `type` (and `enum`); local refs → absolute. */
function normalize(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalize);
  if (!isObject(node)) return node;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
      out[key] = `${SPEC_ID}${value}`;
    } else if (key !== "nullable") {
      out[key] = normalize(value);
    }
  }

  if (node.nullable === true) {
    const type = out.type;
    if (typeof type === "string") out.type = [type, "null"];
    else if (Array.isArray(type) && !type.includes("null")) {
      out.type = [...type, "null"];
    }
    if (Array.isArray(out.enum) && !out.enum.includes(null)) {
      out.enum = [...out.enum, null];
    }
    if (out.type === undefined) {
      // `nullable` beside `$ref` / `allOf`: allow null explicitly.
      const { description, ...rest } = out;
      return {
        ...(description === undefined ? {} : { description }),
        anyOf: [rest, { type: "null" }],
      };
    }
  }
  return out;
}

export type OpenApiValidator = {
  /** Throws with Ajv errors when `body` doesn't match the operation's response. */
  assertResponse: (
    method: string,
    pathTemplate: string,
    status: number,
    body: unknown
  ) => void;
  /** The operation's response schema exists in the spec. */
  hasResponse: (
    method: string,
    pathTemplate: string,
    status: number
  ) => boolean;
};

export function loadOpenApiValidator(
  specPath: string = process.env.PLANEWARD_OPENAPI ?? DEFAULT_OPENAPI_PATH
): OpenApiValidator {
  const raw = parse(readFileSync(specPath, "utf8")) as JsonObject;
  const spec = normalize(raw) as JsonObject;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addSchema(
    { ...spec, $id: SPEC_ID } as object,
    undefined,
    undefined,
    false
  );

  const cache = new Map<string, ValidateFunction | null>();

  /** Follows `#/components/responses/*` refs (response objects, not schemas). */
  function resolveResponse(response: Json | undefined): JsonObject | null {
    if (!isObject(response)) return null;
    const ref = response.$ref;
    if (typeof ref === "string") {
      const pointer = ref.slice(SPEC_ID.length + 2).split("/");
      let node: Json | undefined = spec;
      for (const part of pointer) {
        node = isObject(node)
          ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")]
          : undefined;
      }
      return resolveResponse(node);
    }
    return response;
  }

  function validatorFor(method: string, path: string, status: number) {
    const key = `${method} ${path} ${status}`;
    if (cache.has(key)) return cache.get(key)!;
    const paths = spec.paths as JsonObject;
    const operation = (paths[path] as JsonObject | undefined)?.[
      method.toLowerCase()
    ] as JsonObject | undefined;
    const responses = operation?.responses as JsonObject | undefined;
    const response = resolveResponse(responses?.[String(status)]);
    const content = response?.content as JsonObject | undefined;
    const schema = (content?.["application/json"] as JsonObject | undefined)
      ?.schema;
    const validate = schema ? ajv.compile(schema as object) : null;
    cache.set(key, validate);
    return validate;
  }

  return {
    hasResponse: (method, path, status) =>
      validatorFor(method, path, status) !== null,
    assertResponse(method, path, status, body) {
      const validate = validatorFor(method, path, status);
      if (!validate) {
        throw new Error(
          `No ${status} JSON response for ${method} ${path} in the spec.`
        );
      }
      if (!validate(body)) {
        const errors = (validate.errors ?? [])
          .map(
            (error: ErrorObject) =>
              `${error.instancePath || "/"} ${error.message}`
          )
          .join("; ");
        throw new Error(
          `${method} ${path} ${status} does not match v1.yaml: ${errors}\n${JSON.stringify(body, null, 2).slice(0, 2000)}`
        );
      }
    },
  };
}
