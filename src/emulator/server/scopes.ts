import { APP_GRANTABLE_SCOPES, type AppGrantableScope } from "../../manifest";

/**
 * Narrow scopes another app-grantable scope also satisfies (Planeward
 * `COARSE_IMPLIES_NARROW` in `api-permission-bitfield.ts`, limited to scopes
 * an app can hold). Pairs are `[narrow, coarse]`. `COMMUNITY_MESSAGES_WRITE`
 * deliberately does not imply `COMMUNITY_MESSAGES_READ`.
 */
const IMPLIED_BY: ReadonlyArray<
  readonly [AppGrantableScope, AppGrantableScope]
> = [["COURSES_READ", "COURSE_PROGRESS_WRITE"]];

/** True when `granted` holds `required` exactly or through an implication. */
export function grantsScope(
  granted: ReadonlySet<AppGrantableScope>,
  required: AppGrantableScope
): boolean {
  if (granted.has(required)) return true;
  return IMPLIED_BY.some(
    ([narrow, coarse]) => narrow === required && granted.has(coarse)
  );
}

export type ScopeRequirement = {
  scopes: readonly AppGrantableScope[];
  /** Pass when any one scope is held (default: every one). */
  anyOf?: boolean;
};

export type ScopeCheck =
  | { ok: true; scope: AppGrantableScope | null }
  | { ok: false; scope: AppGrantableScope; missingScope: AppGrantableScope };

/**
 * Route scope check like `withAPIKey`'s `callerHoldsScopes`. On failure
 * `missingScope` is the first scope not held (with `anyOf`, the first listed).
 * `scope` is what the request was authorized by, for the request log.
 */
export function checkScopes(
  granted: ReadonlySet<AppGrantableScope>,
  requirement: ScopeRequirement
): ScopeCheck {
  const { scopes, anyOf = false } = requirement;
  const first = scopes[0];
  if (!first) return { ok: true, scope: null };

  if (anyOf) {
    const held = scopes.find((scope) => grantsScope(granted, scope));
    return held
      ? { ok: true, scope: held }
      : { ok: false, scope: first, missingScope: first };
  }

  const missing = scopes.find((scope) => !grantsScope(granted, scope));
  return missing
    ? { ok: false, scope: missing, missingScope: missing }
    : { ok: true, scope: first };
}

/** Manifest scopes in Planeward permission-bit order (as `app.installed` lists them). */
export function orderedScopes(
  scopes: readonly AppGrantableScope[]
): AppGrantableScope[] {
  const set = new Set(scopes);
  return APP_GRANTABLE_SCOPES.filter((scope) => set.has(scope));
}
