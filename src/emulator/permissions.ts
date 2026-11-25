/**
 * App-declared permissions in the emulator: the declaration the app serves at
 * `/.well-known/planeward-permissions`, the grants from `dev.grants`, and
 * Planeward's rules for resolving them into a viewer token's `permissions`.
 * Pure, so the host UI shows the same result the token gets.
 */
import type {
  AppView,
  AppViewerRole,
  PlanewardPermissionsResponse,
} from "@planeward/sdk";

import type { CommunityGrantValue, PermissionGrants } from "../manifest";

/** Reading the app's declaration. */
export type PermissionsDeclaration = {
  /** The URL that was fetched. */
  url: string;
  /** ISO 8601. */
  fetchedAt: string;
} & (
  | { status: "ok"; declaration: PlanewardPermissionsResponse }
  /** 404: the app declares no permissions. */
  | { status: "none" }
  /** Answered 200, but the body breaks the rules. */
  | { status: "invalid"; errors: string[] }
  /** Not reachable, or an HTTP status other than 200 and 404. */
  | { status: "error"; error: string }
);

/** Who the token is for, as far as permissions go. */
export type PermissionsViewer = {
  view: AppView;
  role: AppViewerRole;
  /** The simulated plan of a member viewer; ignored for admins. */
  planId: string | null;
};

/**
 * One community key through production's layers: the declared default, then
 * `@everyone`, then the member's plans combined (any On beats Off). Staff
 * role grants come last in production; the emulator has none, so an admin
 * resolves like `@everyone` (admins get nothing automatically).
 */
export function resolveCommunityKey(input: {
  defaultOn: boolean;
  everyone: CommunityGrantValue | undefined;
  plans: (CommunityGrantValue | undefined)[];
}): boolean {
  let granted = input.defaultOn;
  if (input.everyone) granted = input.everyone === "on";
  if (input.plans.includes("on")) granted = true;
  else if (input.plans.includes("off")) granted = false;
  return granted;
}

/**
 * The keys a viewer token carries: community keys for the Experience view,
 * dashboard keys (on/off for the simulated staff role, else the declared
 * default) for the Dashboard view.
 */
export function resolvePermissions(
  declaration: PlanewardPermissionsResponse | null,
  grants: PermissionGrants,
  viewer: PermissionsViewer
): string[] {
  if (!declaration) return [];
  if (viewer.view === "dashboard") {
    return declaration.dashboard
      .filter(
        (entry) => grants.dashboard?.[entry.key] ?? entry.default === "on"
      )
      .map((entry) => entry.key);
  }
  const planIds =
    viewer.role === "member" && viewer.planId ? [viewer.planId] : [];
  return declaration.community
    .filter((entry) =>
      resolveCommunityKey({
        defaultOn: entry.default === "on",
        everyone: grants.everyone?.[entry.key],
        plans: planIds.map((planId) => grants.plans?.[planId]?.[entry.key]),
      })
    )
    .map((entry) => entry.key);
}

const nonEmpty = <T extends object>(value: T | undefined) =>
  value && Object.keys(value).length > 0 ? value : undefined;

/** Drops empty maps so `dev.grants` stays minimal (`{}` when nothing is set). */
export function normalizeGrants(grants: PermissionGrants): PermissionGrants {
  const plans = Object.fromEntries(
    Object.entries(grants.plans ?? {}).filter(
      ([, keys]) => Object.keys(keys).length > 0
    )
  );
  const out: PermissionGrants = {};
  const everyone = nonEmpty(grants.everyone);
  if (everyone) out.everyone = everyone;
  if (Object.keys(plans).length > 0) out.plans = plans;
  const dashboard = nonEmpty(grants.dashboard);
  if (dashboard) out.dashboard = dashboard;
  return out;
}

/** Community grant target in the Permissions panel. */
export type CommunityTarget =
  { kind: "everyone" } | { kind: "plan"; planId: string };

/** Sets (or, with `undefined`, unsets) one community key for one target. */
export function setCommunityGrant(
  grants: PermissionGrants,
  target: CommunityTarget,
  key: string,
  value: CommunityGrantValue | undefined
): PermissionGrants {
  const update = (keys: Record<string, CommunityGrantValue> = {}) => {
    const next = { ...keys };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  };
  return normalizeGrants(
    target.kind === "everyone"
      ? { ...grants, everyone: update(grants.everyone) }
      : {
          ...grants,
          plans: {
            ...grants.plans,
            [target.planId]: update(grants.plans?.[target.planId]),
          },
        }
  );
}

/** Sets one dashboard key on or off. */
export function setDashboardGrant(
  grants: PermissionGrants,
  key: string,
  on: boolean
): PermissionGrants {
  return normalizeGrants({
    ...grants,
    dashboard: { ...grants.dashboard, [key]: on },
  });
}
