import type { AppTheme } from "@planeward/sdk";
import { PlugZapIcon, RefreshCwIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  APP_FRAME_SANDBOX,
  appFrameAllow,
  appFrameOrigin,
  createAppFrameHost,
  type AppFrameHost,
  type AppViewerToken,
} from "../host";
import { Button, cn } from "./ui";

/** Same as production `APP_FRAME_READY_TIMEOUT_MS`. */
const APP_FRAME_READY_TIMEOUT_MS = 15_000;

/** How often to re-check an app that isn't running yet. */
const OFFLINE_RETRY_MS = 2_000;

type FrameStatus =
  | "probing"
  | "offline"
  | "loading"
  | "loaded"
  | "ready"
  | "timeout"
  | "unavailable";

const FRAME_MOUNTED: ReadonlySet<FrameStatus> = new Set([
  "loading",
  "loaded",
  "ready",
  "timeout",
  "unavailable",
]);

/**
 * The app iframe plus the host side of the postMessage protocol
 * (`createAppFrameHost`). A new `frameKey` (viewer, role or view) remounts
 * the iframe with a fresh token cache, like production's per-load cache.
 */
export function AppFrame({
  src,
  title,
  theme,
  frameKey,
  dev,
  fetchToken,
}: {
  src: string;
  title: string;
  theme: AppTheme;
  frameKey: string;
  dev: { command: string; url: string };
  fetchToken: () => Promise<AppViewerToken>;
}) {
  const origin = appFrameOrigin(src);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<AppFrameHost | null>(null);
  const themeRef = useRef(theme);
  const fetchTokenRef = useRef(fetchToken);
  const [attempt, setAttempt] = useState(0);
  const loadKey = `${src}#${frameKey}#${attempt}`;
  const [frameState, setFrameState] = useState<{
    key: string;
    status: FrameStatus;
    error: string | null;
    /** A re-probe while offline: keep the offline card up instead of "Loading…". */
    background?: boolean;
  }>({ key: loadKey, status: "probing", error: null });
  const current = frameState.key === loadKey;
  const status = current ? frameState.status : "probing";
  const error = current ? frameState.error : null;
  const offline =
    status === "offline" ||
    (status === "probing" && current && frameState.background === true);
  const mounted = FRAME_MOUNTED.has(status);

  useEffect(() => {
    themeRef.current = theme;
    fetchTokenRef.current = fetchToken;
  });

  // Checks the dev server answers before mounting, so "not running" gets a
  // useful hint instead of the browser's connection error page.
  useEffect(() => {
    if (status !== "probing" || !origin) {
      return;
    }
    let cancelled = false;
    fetch(src, { mode: "no-cors", cache: "no-store" }).then(
      () => {
        if (!cancelled) {
          setFrameState({ key: loadKey, status: "loading", error: null });
        }
      },
      () => {
        if (!cancelled) {
          setFrameState({ key: loadKey, status: "offline", error: null });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [status, origin, src, loadKey]);

  useEffect(() => {
    if (status !== "offline") {
      return;
    }
    const timer = window.setTimeout(() => {
      setFrameState({
        key: loadKey,
        status: "probing",
        error: null,
        background: true,
      });
    }, OFFLINE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [status, loadKey]);

  // One host per iframe load; it only answers the iframe's window and origin.
  useEffect(() => {
    if (!mounted) {
      return;
    }
    const update = (
      next: (current: FrameStatus) => FrameStatus,
      err?: string
    ) =>
      setFrameState((state) => {
        const current = state.key === loadKey ? state.status : "probing";
        return {
          key: loadKey,
          status: next(current),
          error: err ?? (state.key === loadKey ? state.error : null),
        };
      });
    const host = createAppFrameHost({
      src,
      getTarget: () => iframeRef.current?.contentWindow ?? null,
      theme: themeRef.current,
      fetchToken: () => fetchTokenRef.current(),
      onReady: () =>
        update((current) => (current === "unavailable" ? current : "ready")),
      onUnavailable: (cause) =>
        update(
          () => "unavailable",
          cause instanceof Error ? cause.message : String(cause)
        ),
    });
    hostRef.current = host;
    const listener = (event: MessageEvent) => host.handleMessage(event);
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      host.dispose();
      if (hostRef.current === host) {
        hostRef.current = null;
      }
    };
    // `mounted` flips once per load; the host must not be recreated on status changes.
  }, [mounted, loadKey, src]);

  useEffect(() => {
    hostRef.current?.setTheme(theme);
  }, [theme, status]);

  useEffect(() => {
    if (status !== "loading" && status !== "loaded") {
      return;
    }
    const timer = window.setTimeout(() => {
      setFrameState((state) =>
        state.key === loadKey &&
        (state.status === "loading" || state.status === "loaded")
          ? { ...state, status: "timeout" }
          : state
      );
    }, APP_FRAME_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [status, loadKey]);

  const retry = () => setAttempt((value) => value + 1);

  if (!origin) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <FrameState
          title="This app can't be opened"
          description={`"${src}" isn't an http(s) URL. Check dev.url and the paths in planeward.json.`}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1" data-status={status}>
      {mounted ? (
        <iframe
          key={loadKey}
          ref={iframeRef}
          src={src}
          title={title}
          sandbox={APP_FRAME_SANDBOX}
          allow={appFrameAllow(src)}
          referrerPolicy="strict-origin-when-cross-origin"
          className={cn(
            "bg-background absolute inset-0 size-full border-0",
            (status === "timeout" || status === "unavailable") && "invisible"
          )}
          onLoad={() =>
            setFrameState((state) =>
              state.key === loadKey && state.status === "loading"
                ? { ...state, status: "loaded" }
                : state
            )
          }
        />
      ) : null}
      {(status === "probing" && !offline) || status === "loading" ? (
        <div
          className="bg-background absolute inset-0 grid place-items-center"
          role="status"
          aria-live="polite"
        >
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <RefreshCwIcon
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            Loading {title}…
          </span>
        </div>
      ) : null}
      {offline ? (
        <FrameState
          icon={<PlugZapIcon aria-hidden className="size-5" />}
          title={`${title} isn't running`}
          description={`Nothing answered at ${dev.url}. planeward dev starts it with the command below; check its output, or start it yourself. This page retries every few seconds.`}
          code={dev.command}
          action={
            <Button size="sm" onClick={retry}>
              <RefreshCwIcon className="size-3.5" aria-hidden />
              Retry now
            </Button>
          }
        />
      ) : null}
      {status === "timeout" ? (
        <FrameState
          title="This app didn't respond"
          description={`${title} loaded but never sent planeward:app:ready within ${APP_FRAME_READY_TIMEOUT_MS / 1000}s. Call createPlanewardApp() from @planeward/sdk on the page at ${src}.`}
          code={dev.command}
          action={
            <Button size="sm" onClick={retry}>
              <RefreshCwIcon className="size-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : null}
      {status === "unavailable" ? (
        <FrameState
          title="This app is no longer available"
          description={`Minting the viewer token failed${error ? `: ${error}` : "."} The app was sent planeward:app:error.`}
          action={
            <Button size="sm" onClick={retry}>
              <RefreshCwIcon className="size-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

export function FrameState({
  icon,
  title,
  description,
  code,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  code?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <div className="border-border bg-muted text-muted-foreground grid size-10 place-items-center rounded-lg border">
        {icon ?? <UnplugIcon aria-hidden className="size-5" />}
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm text-pretty">
          {description}
        </p>
      </div>
      {code ? (
        <code className="border-border bg-muted rounded-md border px-2.5 py-1.5 font-mono text-xs">
          {code}
        </code>
      ) : null}
      {action}
    </div>
  );
}
