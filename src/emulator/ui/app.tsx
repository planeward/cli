import type { AppTheme, AppView, AppViewerRole } from "@planeward/sdk";
import { XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type {
  ActivityAction,
  ApiRequestLogEntry,
  EmulatorState,
  FixtureNotification,
  WebhookDeliveryEntry,
} from "../contract";
import { emulatorApi, subscribeToEmulator } from "./api";
import { ActivityPanel } from "./components/activity-panel";
import { AppFrame, FrameState } from "./components/app-frame";
import { InboxPanel } from "./components/inbox-panel";
import { LeftRail } from "./components/left-rail";
import { RequestsPanel } from "./components/requests-panel";
import { TopBar } from "./components/top-bar";
import { Badge, Button, cn } from "./components/ui";
import { WebhooksPanel } from "./components/webhooks-panel";
import {
  activeDeepLink,
  appFrameKey,
  appFrameSrc,
  inboxCount,
  nextDeepLink,
  openNotificationSteps,
  type DeepLink,
  type DeepLinkEvent,
} from "./inbox";

/** Keep the logs bounded in a long session. */
const MAX_LOG_ENTRIES = 500;

type Tab = "activity" | "requests" | "webhooks" | "inbox";

const TAB_IDS: Tab[] = ["activity", "requests", "webhooks", "inbox"];

/** The OS theme, used until the emulator state says otherwise. */
function systemTheme(): AppTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Upserts by id, newest first (entries arrive oldest first). */
function upsert<T extends { id: string }>(list: T[], incoming: T[]): T[] {
  if (incoming.length === 0) {
    return list;
  }
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const added: T[] = [];
  for (const entry of incoming) {
    if (byId.has(entry.id)) {
      byId.set(entry.id, entry);
    } else {
      added.unshift(entry);
      byId.set(entry.id, entry);
    }
  }
  return [...added, ...list.map((entry) => byId.get(entry.id) ?? entry)].slice(
    0,
    MAX_LOG_ENTRIES
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

export function App() {
  const [state, setState] = useState<EmulatorState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requests, setRequests] = useState<ApiRequestLogEntry[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryEntry[]>([]);
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("activity");
  const [panelOpen, setPanelOpen] = useState(true);
  const [resetCount, setResetCount] = useState(0);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(
    null
  );
  const [deepLink, setDeepLink] = useState<DeepLink | null>(null);
  const [fallbackTheme] = useState(systemTheme);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());

  const backfill = useCallback(async () => {
    try {
      const [nextState, nextRequests, nextDeliveries] = await Promise.all([
        emulatorApi.getState(),
        emulatorApi.listRequests(),
        emulatorApi.listDeliveries(),
      ]);
      setState(nextState);
      setRequests((list) => upsert(list, nextRequests));
      setDeliveries((list) => upsert(list, nextDeliveries));
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    }
  }, []);

  // Every (re)connect backfills state and logs; a failed connect still loads
  // what it can so the page explains why the emulator isn't reachable.
  useEffect(
    () =>
      subscribeToEmulator({
        onOpen: () => {
          setConnected(true);
          void backfill();
        },
        onError: () => {
          setConnected(false);
          void backfill();
        },
        onEvent: (event) => {
          switch (event.type) {
            case "state":
              setState(event.state);
              break;
            case "request":
              setRequests((list) => upsert(list, [event.entry]));
              break;
            case "delivery":
              setDeliveries((list) => upsert(list, [event.entry]));
              break;
          }
        },
      }),
    [backfill]
  );

  const theme = state?.theme ?? fallbackTheme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const deliveryMap = useMemo(
    () => new Map(deliveries.map((entry) => [entry.id, entry])),
    [deliveries]
  );

  if (!state) {
    return (
      <main className="relative flex h-full">
        {loadError ? (
          <FrameState
            title="Can't reach the emulator"
            description={`${loadError} Is planeward dev still running?`}
            action={
              <Button size="sm" onClick={() => void backfill()}>
                Retry
              </Button>
            }
          />
        ) : (
          <FrameState title="Starting…" description="Loading emulator state." />
        )}
      </main>
    );
  }

  const { app, viewer, view } = state;
  const role: AppViewerRole = view === "dashboard" ? "admin" : viewer.role;
  const frameLink = activeDeepLink(deepLink, state);
  const src = appFrameSrc(app, view, frameLink);

  function updateDeepLink(event: DeepLinkEvent) {
    setDeepLink((current) => nextDeepLink(current, event));
  }

  /** Resolves to false when the task failed (the error is shown as a notice). */
  async function mutate(task: () => Promise<EmulatorState>): Promise<boolean> {
    setBusy(true);
    try {
      setState(await task());
      return true;
    } catch (cause) {
      setNotice(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function changeViewer(memberId: string) {
    updateDeepLink({ type: "choose-viewer" });
    void mutate(() => emulatorApi.setViewer({ memberId, role: viewer.role }));
  }

  function changeRole(nextRole: AppViewerRole) {
    updateDeepLink({ type: "choose-role" });
    void mutate(() =>
      emulatorApi.setViewer({ memberId: viewer.memberId, role: nextRole })
    );
  }

  /**
   * Opens a notification like a member clicking it in the bell: the recipient
   * becomes the viewer (as a member) in the Experience view, and the frame
   * loads the app at the notification's path. The deep link is set first;
   * `activeDeepLink` only applies it once the state shows the recipient in
   * the Experience view, so the previous viewer never loads it.
   */
  function openNotification(notification: FixtureNotification) {
    updateDeepLink({ type: "open", notification, nonce: Date.now() });
    const steps = openNotificationSteps({ viewer, view }, notification);
    if (!steps.viewer && !steps.view) {
      return;
    }
    void mutate(async () => {
      if (steps.viewer) {
        const next = await emulatorApi.setViewer(steps.viewer);
        if (!steps.view) {
          return next;
        }
      }
      return emulatorApi.setView("experience");
    }).then((ok) => {
      if (!ok) {
        updateDeepLink({ type: "open-failed" });
      }
    });
  }

  function changeView(nextView: AppView) {
    // Also when it's already the view: clicking the app channel goes back to
    // the plain experience URL.
    updateDeepLink({ type: "choose-view" });
    if (nextView === view) {
      return;
    }
    void mutate(async () => {
      // Production always opens the dashboard as admin.
      if (nextView === "dashboard" && viewer.role !== "admin") {
        await emulatorApi.setViewer({
          memberId: viewer.memberId,
          role: "admin",
        });
      }
      return emulatorApi.setView(nextView);
    });
  }

  function changeTheme(nextTheme: AppTheme) {
    const previous = state;
    setState((current) =>
      current ? { ...current, theme: nextTheme } : current
    );
    emulatorApi.setTheme(nextTheme).then(setState, (cause) => {
      setState(previous);
      setNotice(errorMessage(cause));
    });
  }

  async function reset() {
    const next = await emulatorApi.reset();
    setState(next);
    setResetCount((count) => count + 1);
    updateDeepLink({ type: "reset" });
  }

  async function runActivity(action: ActivityAction) {
    const result = await emulatorApi.runActivity(action);
    setState(result.state);
    return result;
  }

  async function redeliver(deliveryId: string) {
    const entry = await emulatorApi.redeliver(deliveryId);
    setDeliveries((list) => upsert(list, [entry]));
    setFocus({ id: entry.id, nonce: Date.now() });
  }

  function showDelivery(deliveryId: string) {
    setTab("webhooks");
    setPanelOpen(true);
    setFocus({ id: deliveryId, nonce: Date.now() });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = TAB_IDS.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? TAB_IDS[(index + 1) % TAB_IDS.length]
        : event.key === "ArrowLeft"
          ? TAB_IDS[(index - 1 + TAB_IDS.length) % TAB_IDS.length]
          : event.key === "Home"
            ? TAB_IDS[0]
            : event.key === "End"
              ? TAB_IDS[TAB_IDS.length - 1]
              : undefined;
    if (!next) {
      return;
    }
    event.preventDefault();
    setTab(next);
    tabRefs.current.get(next)?.focus();
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "activity", label: "Activity" },
    { id: "requests", label: "Requests", count: requests.length },
    { id: "webhooks", label: "Webhooks", count: deliveries.length },
    {
      id: "inbox",
      label: "Inbox",
      count: inboxCount(state.entities.notifications, viewer.memberId),
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <TopBar
        appName={app.name}
        members={state.entities.members}
        viewerId={viewer.memberId}
        role={role}
        view={view}
        theme={theme}
        busy={busy}
        panelOpen={panelOpen}
        onViewerChange={changeViewer}
        onRoleChange={changeRole}
        onThemeChange={changeTheme}
        onReset={reset}
        onTogglePanel={() => setPanelOpen((open) => !open)}
      />
      {!connected || notice ? (
        <div
          role="alert"
          className="border-border bg-danger-muted text-danger-foreground flex items-center gap-2 border-b px-3 py-1.5 text-xs"
        >
          <span className="flex-1">
            {!connected
              ? "Lost the connection to the emulator. Reconnecting…"
              : notice}
          </span>
          {notice ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <LeftRail
          app={app}
          channels={state.entities.channels}
          view={view}
          busy={busy}
          onViewChange={changeView}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
            <span className="text-foreground font-medium capitalize">
              {view}
            </span>
            {frameLink ? <Badge>notification</Badge> : null}
            <span className="truncate font-mono">
              {src ?? "no dashboardPath"}
            </span>
          </div>
          {src ? (
            <AppFrame
              src={src}
              title={app.name}
              theme={theme}
              frameKey={appFrameKey({
                viewerId: viewer.memberId,
                role,
                view,
                resetCount,
                deepLink: frameLink,
              })}
              dev={app.dev}
              fetchToken={emulatorApi.mintToken}
            />
          ) : (
            <div className="relative flex flex-1">
              <FrameState
                title="No dashboard"
                description="Add dashboardPath to planeward.json and restart planeward dev."
              />
            </div>
          )}
        </main>
        {/* Hidden rather than unmounted, so panel state survives closing it. */}
        <aside
          aria-label="Developer tools"
          hidden={!panelOpen}
          className="border-border bg-background flex w-[min(420px,40vw)] shrink-0 flex-col border-l"
        >
          <div
            role="tablist"
            aria-label="Developer tools"
            className="border-border flex h-10 shrink-0 items-end gap-1 border-b px-2"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                ref={(node) => {
                  if (node) {
                    tabRefs.current.set(item.id, node);
                  } else {
                    tabRefs.current.delete(item.id);
                  }
                }}
                id={`tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={onTabKeyDown}
                className={cn(
                  "-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium",
                  tab === item.id
                    ? "border-foreground text-foreground"
                    : "text-muted-foreground hover:text-foreground border-transparent"
                )}
              >
                {item.label}
                {item.count ? (
                  <span className="bg-muted text-muted-foreground rounded px-1 font-mono text-[10px]">
                    {item.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {/* All panels stay mounted so drafts, filters and results survive tab switches. */}
          <div
            id="panel-activity"
            role="tabpanel"
            aria-labelledby="tab-activity"
            hidden={tab !== "activity"}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <ActivityPanel
              state={state}
              deliveries={deliveryMap}
              run={runActivity}
              onShowDelivery={showDelivery}
            />
          </div>
          <div
            id="panel-requests"
            role="tabpanel"
            aria-labelledby="tab-requests"
            hidden={tab !== "requests"}
            className="flex min-h-0 flex-1 flex-col"
          >
            <RequestsPanel entries={requests} />
          </div>
          <div
            id="panel-webhooks"
            role="tabpanel"
            aria-labelledby="tab-webhooks"
            hidden={tab !== "webhooks"}
            className="flex min-h-0 flex-1 flex-col"
          >
            <WebhooksPanel
              entries={deliveries}
              focus={focus}
              onRedeliver={redeliver}
            />
          </div>
          <div
            id="panel-inbox"
            role="tabpanel"
            aria-labelledby="tab-inbox"
            hidden={tab !== "inbox"}
            className="flex min-h-0 flex-1 flex-col"
          >
            <InboxPanel
              notifications={state.entities.notifications}
              members={state.entities.members}
              viewerId={viewer.memberId}
              activeId={frameLink?.notificationId ?? null}
              busy={busy}
              onOpen={openNotification}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
