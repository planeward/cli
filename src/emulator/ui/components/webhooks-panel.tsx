import { ChevronRightIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  WebhookDeliveryEntry,
  WebhookDeliveryStatus,
} from "../../contract";
import { EmptyList } from "./requests-panel";
import { Badge, Button, cn, ErrorText, formatTime, JsonBlock } from "./ui";

const STATUS_TONE: Record<
  WebhookDeliveryStatus,
  "neutral" | "success" | "danger" | "warning"
> = {
  pending: "neutral",
  succeeded: "success",
  failed: "danger",
  skipped: "warning",
};

export function DeliveryStatusBadge({
  status,
}: {
  status: WebhookDeliveryStatus;
}) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

/** Every webhook delivery, newest first, with Redeliver. */
export function WebhooksPanel({
  entries,
  focus,
  onRedeliver,
}: {
  entries: WebhookDeliveryEntry[];
  /** A delivery to expand and scroll to (from the Activity panel); `nonce` re-triggers it. */
  focus: { id: string; nonce: number } | null;
  onRedeliver: (deliveryId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null
  );
  const listRef = useRef<HTMLUListElement>(null);
  // Expand a newly focused delivery (state adjusted during render, not in an effect).
  const focusId = focus?.id ?? null;
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus && !expanded.has(focus.id)) {
      setExpanded(new Set(expanded).add(focus.id));
    }
  }
  const isOpen = (id: string) => expanded.has(id);

  useEffect(() => {
    if (!focus) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-delivery-id="${CSS.escape(focus.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function redeliver(id: string) {
    setPending(id);
    setError(null);
    try {
      await onRedeliver(id);
    } catch (cause) {
      setError({
        id,
        message: cause instanceof Error ? cause.message : "Redeliver failed.",
      });
    } finally {
      setPending(null);
    }
  }

  if (entries.length === 0) {
    return (
      <EmptyList
        title="No webhook deliveries yet"
        description="Use the Activity tab (or planeward trigger) to fire events; each signed delivery to your webhookPath shows up here."
      />
    );
  }

  return (
    <ul
      ref={listRef}
      className="divide-border min-h-0 flex-1 divide-y overflow-y-auto"
    >
      {entries.map((entry) => {
        const open = isOpen(entry.id);
        return (
          <li
            key={entry.id}
            data-delivery-id={entry.id}
            className={cn(entry.id === focusId && "bg-accent/50")}
          >
            <div className="flex items-start gap-1 pr-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(entry.id)}
                className="hover:bg-accent/60 flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left"
              >
                <span className="flex w-full items-center gap-2">
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "text-muted-foreground size-3.5 shrink-0 transition-transform",
                      open && "rotate-90"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                    {entry.event}
                  </span>
                  <DeliveryStatusBadge status={entry.status} />
                </span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 pl-5.5 text-[11px]">
                  <span>{formatTime(entry.createdAt)}</span>
                  {entry.httpStatus !== null ? (
                    <span>HTTP {entry.httpStatus}</span>
                  ) : null}
                  {entry.latencyMs !== null ? (
                    <span>{Math.round(entry.latencyMs)} ms</span>
                  ) : null}
                  {entry.redeliveryOf ? <span>redelivery</span> : null}
                </span>
                {entry.skippedReason ? (
                  <span className="text-warning-foreground pl-5.5 text-xs">
                    {entry.skippedReason}
                  </span>
                ) : null}
              </button>
              {entry.url ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5"
                  disabled={pending !== null}
                  title={`POST ${entry.url}`}
                  onClick={() => redeliver(entry.id)}
                >
                  <SendIcon className="size-3" aria-hidden />
                  {pending === entry.id ? "Sending…" : "Redeliver"}
                </Button>
              ) : (
                <span className="text-muted-foreground mt-2.5 shrink-0 text-xs">
                  No webhook URL
                </span>
              )}
            </div>
            {error?.id === entry.id ? (
              <div className="px-3 pb-2">
                <ErrorText role="alert">{error.message}</ErrorText>
              </div>
            ) : null}
            {open ? (
              <div className="flex flex-col gap-2 px-3 pb-3">
                <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt>Delivery</dt>
                  <dd className="truncate font-mono">{entry.id}</dd>
                  {entry.redeliveryOf ? (
                    <>
                      <dt>Repeats</dt>
                      <dd className="truncate font-mono">
                        {entry.redeliveryOf}
                      </dd>
                    </>
                  ) : null}
                  <dt>URL</dt>
                  <dd className="truncate font-mono">{entry.url ?? "none"}</dd>
                </dl>
                {entry.error ? <ErrorText>{entry.error}</ErrorText> : null}
                <JsonBlock label="Envelope" value={entry.envelope} />
                <JsonBlock label="Response" value={entry.responseBody} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
