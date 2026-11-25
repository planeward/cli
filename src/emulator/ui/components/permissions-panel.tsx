import type { PlanewardPermissionEntry } from "@planeward/sdk";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { CommunityGrantValue, PermissionGrants } from "../../../manifest";
import type { EmulatorState } from "../../contract";
import {
  resolvePermissions,
  setCommunityGrant,
  setDashboardGrant,
  type CommunityTarget,
  type PermissionsDeclaration,
} from "../../permissions";
import { emulatorApi } from "../api";
import { EmptyList } from "./requests-panel";
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Segmented,
  Select,
  type Option,
} from "./ui";

/** Who the frame is simulated as: `plan:<id>` is a member on that plan. */
export type SimulatedViewer =
  "member" | "admin" | "dashboard" | `plan:${string}`;

export function simulatedViewerOf(state: EmulatorState): SimulatedViewer {
  if (state.view === "dashboard") return "dashboard";
  if (state.viewer.role === "admin") return "admin";
  return state.viewer.planId ? `plan:${state.viewer.planId}` : "member";
}

type Tri = CommunityGrantValue | "unset";

const TRI_OPTIONS: { value: Tri; label: string }[] = [
  { value: "on", label: "On" },
  { value: "unset", label: "Unset" },
  { value: "off", label: "Off" },
];

const targetValue = (target: CommunityTarget) =>
  target.kind === "everyone" ? "everyone" : `plan:${target.planId}`;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

/**
 * Reads the app's `/.well-known/planeward-permissions`, simulates a viewer,
 * and grants keys like a workspace would. Every change is saved to
 * planeward.json `dev.grants` and reloads the frame with a new token.
 */
export function PermissionsPanel({
  state,
  busy,
  onSimulate,
  onGrantsChange,
  onDeclarationChange,
}: {
  state: EmulatorState;
  busy: boolean;
  onSimulate: (viewer: SimulatedViewer) => void;
  onGrantsChange: (grants: PermissionGrants) => Promise<void>;
  /** The declaration was read again: tokens may carry other keys now. */
  onDeclarationChange: () => void;
}) {
  const { app, grants, viewer, view } = state;
  const [declaration, setDeclaration] = useState<PermissionsDeclaration | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [target, setTarget] = useState<CommunityTarget>({ kind: "everyone" });

  useEffect(() => {
    let cancelled = false;
    emulatorApi.getPermissions().then(
      (result) => {
        if (cancelled) return;
        setDeclaration(result);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause));
        setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    try {
      setDeclaration(await emulatorApi.getPermissions(true));
      onDeclarationChange();
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function save(next: PermissionGrants) {
    setSaving(true);
    setSaveError(null);
    try {
      await onGrantsChange(next);
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const declared =
    declaration?.status === "ok" ? declaration.declaration : null;
  // A plan removed from dev.plans falls back to @everyone.
  const activeTarget: CommunityTarget =
    target.kind === "plan" &&
    !app.plans.some((plan) => plan.id === target.planId)
      ? { kind: "everyone" }
      : target;
  const granted = resolvePermissions(declared, grants, {
    view,
    role: view === "dashboard" ? "admin" : viewer.role,
    planId: viewer.planId,
  });
  const simulated = simulatedViewerOf(state);
  const simulateOptions: Option[] = [
    { value: "member", label: "Member (no plan)" },
    ...app.plans.map((plan) => ({
      value: `plan:${plan.id}`,
      label: `Member on ${plan.name}`,
    })),
    { value: "admin", label: "Admin (experience)" },
    {
      value: "dashboard",
      label: "Dashboard (staff)",
      disabled: !app.dashboardUrl,
    },
  ];
  const targetOptions: Option[] = [
    { value: "everyone", label: "@everyone" },
    ...app.plans.map((plan) => ({
      value: `plan:${plan.id}`,
      label: `Plan: ${plan.name}`,
    })),
  ];
  const communityGrants =
    activeTarget.kind === "everyone"
      ? grants.everyone
      : grants.plans?.[activeTarget.planId];
  const disabled = busy || saving;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-border flex items-center gap-2 border-b p-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
          title={declaration?.url}
        >
          {declaration?.url ?? "/.well-known/planeward-permissions"}
        </span>
        {declaration ? <DeclarationBadge declaration={declaration} /> : null}
        <Button
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label="Read the declaration again"
        >
          <RefreshCwIcon className="size-3.5" aria-hidden />
          {loading ? "Reading…" : "Refresh"}
        </Button>
      </div>

      {loadError ? (
        <ErrorText role="alert" className="p-3">
          {loadError}
        </ErrorText>
      ) : null}
      {declaration?.status === "error" ? (
        <EmptyList
          title="Can't read the declaration"
          description={`${declaration.error} Tokens carry no permissions until it answers; press Refresh once the app is up.`}
        />
      ) : null}
      {declaration?.status === "none" ? (
        <EmptyList
          title="No permissions declared"
          description="The app answered 404. Serve definePermissions() from @planeward/sdk/server as JSON at /.well-known/planeward-permissions, then press Refresh."
        />
      ) : null}
      {declaration?.status === "invalid" ? (
        <div className="flex flex-col gap-1 p-3">
          <p className="text-sm font-medium">The declaration is invalid</p>
          <p className="text-muted-foreground text-xs">
            Planeward would reject it, so tokens carry no permissions. Fix these
            and press Refresh:
          </p>
          <ul className="flex flex-col gap-0.5">
            {declaration.errors.map((error) => (
              <li key={error}>
                <ErrorText className="font-mono text-[11px]">{error}</ErrorText>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {declared ? (
        <div className="flex flex-col gap-4 p-3">
          <section className="flex flex-col gap-2">
            <Field
              label="Simulate"
              hint={
                app.plans.length === 0
                  ? 'Add "plans": [{ "id", "name" }] under dev in planeward.json to simulate members on a plan.'
                  : undefined
              }
            >
              {(id) => (
                <Select
                  id={id}
                  value={simulated}
                  disabled={disabled}
                  options={simulateOptions}
                  onChange={(event) =>
                    onSimulate(event.target.value as SimulatedViewer)
                  }
                />
              )}
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">
                Token permissions
              </span>
              <div className="flex flex-wrap gap-1">
                {granted.length ? (
                  granted.map((key) => (
                    <Badge key={key} tone="success">
                      {key}
                    </Badge>
                  ))
                ) : (
                  <span className="text-muted-foreground text-xs">None</span>
                )}
              </div>
              <p className="text-muted-foreground text-xs text-pretty">
                {simulated === "dashboard"
                  ? "Dashboard keys for a staff role: on/off below, else the declared default. The workspace owner would have them all."
                  : simulated === "admin"
                    ? "Admins get no app permissions automatically. The emulator has no staff-role grants, so an admin resolves like @everyone."
                    : "Community keys: the declared default, then @everyone, then the member's plans (any On beats Off)."}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <h3 className="flex-1 text-sm font-semibold">Community</h3>
              {declared.community.length ? (
                <Select
                  aria-label="Grant community permissions to"
                  className="w-48"
                  value={targetValue(activeTarget)}
                  disabled={disabled}
                  options={targetOptions}
                  onChange={(event) => {
                    const value = event.target.value;
                    setTarget(
                      value === "everyone"
                        ? { kind: "everyone" }
                        : { kind: "plan", planId: value.slice("plan:".length) }
                    );
                  }}
                />
              ) : null}
            </div>
            <PermissionRows
              entries={declared.community}
              empty="No community permissions declared."
              control={(entry) => (
                <Segmented<Tri>
                  label={`${entry.name} for ${activeTarget.kind === "everyone" ? "@everyone" : "the plan"}`}
                  value={communityGrants?.[entry.key] ?? "unset"}
                  disabled={disabled}
                  options={TRI_OPTIONS}
                  onChange={(value) =>
                    void save(
                      setCommunityGrant(
                        grants,
                        activeTarget,
                        entry.key,
                        value === "unset" ? undefined : value
                      )
                    )
                  }
                />
              )}
            />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Dashboard</h3>
            <PermissionRows
              entries={declared.dashboard}
              empty="No dashboard permissions declared."
              control={(entry) => (
                <Segmented<"on" | "off">
                  label={`${entry.name} for the staff role`}
                  value={
                    (grants.dashboard?.[entry.key] ?? entry.default === "on")
                      ? "on"
                      : "off"
                  }
                  disabled={disabled}
                  options={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                  onChange={(value) =>
                    void save(
                      setDashboardGrant(grants, entry.key, value === "on")
                    )
                  }
                />
              )}
            />
          </section>

          {saveError ? <ErrorText role="alert">{saveError}</ErrorText> : null}
          <p className="text-muted-foreground text-xs text-pretty">
            Changes are saved to dev.grants in planeward.json and reload the app
            with a new token.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DeclarationBadge({
  declaration,
}: {
  declaration: PermissionsDeclaration;
}) {
  switch (declaration.status) {
    case "ok":
      return (
        <Badge tone="success">
          {declaration.declaration.dashboard.length +
            declaration.declaration.community.length}{" "}
          declared
        </Badge>
      );
    case "none":
      return <Badge>none</Badge>;
    case "invalid":
      return <Badge tone="danger">invalid</Badge>;
    case "error":
      return <Badge tone="warning">unreachable</Badge>;
  }
}

function PermissionRows({
  entries,
  empty,
  control,
}: {
  entries: PlanewardPermissionEntry[];
  empty: string;
  control: (entry: PlanewardPermissionEntry) => ReactNode;
}) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-xs">{empty}</p>;
  }
  return (
    <ul className="divide-border border-border divide-y rounded-md border">
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2 px-2.5 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-xs font-medium">{entry.name}</span>
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
              <span className="truncate font-mono">{entry.key}</span>
              <span className="shrink-0">default {entry.default}</span>
            </span>
            {entry.description ? (
              <span className="text-muted-foreground text-[11px] text-pretty">
                {entry.description}
              </span>
            ) : null}
          </div>
          {control(entry)}
        </li>
      ))}
    </ul>
  );
}
