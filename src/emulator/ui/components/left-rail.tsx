import type { AppView } from "@planeward/sdk";
import { BlocksIcon, HashIcon, LockIcon } from "lucide-react";

import type { EmulatorApp, FixtureChannel } from "../../contract";
import { cn, Segmented } from "./ui";

/** Read-only community sidebar: seeded channels, the app channel highlighted. */
export function LeftRail({
  app,
  channels,
  view,
  busy,
  onViewChange,
}: {
  app: EmulatorApp;
  channels: FixtureChannel[];
  view: AppView;
  busy: boolean;
  onViewChange: (view: AppView) => void;
}) {
  const sorted = [...channels].sort((a, b) => a.position - b.position);
  return (
    <nav
      aria-label="Community"
      className="border-border bg-surface flex w-60 shrink-0 flex-col border-r"
    >
      <div className="border-border flex flex-col gap-2 border-b p-3">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          View
        </span>
        <Segmented<AppView>
          label="App view"
          value={view}
          disabled={busy}
          onChange={onViewChange}
          options={[
            { value: "experience", label: "Experience" },
            {
              value: "dashboard",
              label: "Dashboard",
              disabled: !app.dashboardUrl,
              title: app.dashboardUrl
                ? undefined
                : "Add dashboardPath to planeward.json to enable the dashboard.",
            },
          ]}
        />
        {!app.dashboardUrl ? (
          <span className="text-muted-foreground text-xs">
            No <code className="font-mono">dashboardPath</code> in
            planeward.json.
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <span className="text-muted-foreground px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
          Channels
        </span>
        {sorted.map((channel) => {
          const isApp = channel.id === app.channelId;
          const isPrivate = !channel.everyone.view;
          const Icon =
            channel.kind === "APP"
              ? BlocksIcon
              : isPrivate
                ? LockIcon
                : HashIcon;
          const highlighted = isApp && view === "experience";
          const row = (
            <>
              <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="truncate">{channel.name}</span>
              {isApp ? (
                <span className="text-muted-foreground ml-auto text-[10px] font-medium uppercase">
                  app
                </span>
              ) : isPrivate ? (
                <span className="text-muted-foreground ml-auto text-[10px] font-medium uppercase">
                  private
                </span>
              ) : null}
            </>
          );
          const classes = cn(
            "flex h-8 items-center gap-2 rounded-md px-2 text-sm",
            highlighted
              ? "bg-accent text-foreground font-medium"
              : isApp
                ? "text-foreground"
                : "text-muted-foreground"
          );
          return isApp ? (
            <button
              key={channel.id}
              type="button"
              disabled={busy}
              aria-current={highlighted ? "page" : undefined}
              onClick={() => onViewChange("experience")}
              className={cn(
                classes,
                "hover:bg-accent focus-visible:ring-foreground/30 text-left focus-visible:ring-2 focus-visible:outline-none"
              )}
            >
              {row}
            </button>
          ) : (
            <div key={channel.id} className={classes}>
              {row}
            </div>
          );
        })}
      </div>

      <div className="border-border flex flex-col gap-1.5 border-t p-3">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Granted scopes
        </span>
        {app.scopes.length === 0 ? (
          <span className="text-muted-foreground text-xs">
            None. Add scopes to planeward.json.
          </span>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {app.scopes.map((scope) => (
              <li
                key={scope}
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]"
              >
                {scope}
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
