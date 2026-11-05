import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { ApiRequestLogEntry } from "../../contract";
import { Badge, cn, formatTime, Input, JsonBlock } from "./ui";

function statusTone(status: number) {
  if (status >= 500) return "danger" as const;
  if (status >= 400) return "warning" as const;
  return "success" as const;
}

/** Every mock API call from the app, newest first, live from the SSE stream. */
export function RequestsPanel({ entries }: { entries: ApiRequestLogEntry[] }) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? entries.filter((entry) =>
        [
          entry.method,
          entry.path,
          entry.route ?? "",
          String(entry.status),
          entry.scope ?? "",
          entry.missingScope ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    : entries;

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border border-b p-2">
        <Input
          className="w-full"
          aria-label="Filter requests"
          placeholder="Filter by route, status or scope…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {entries.length === 0 ? (
        <EmptyList
          title="No API requests yet"
          description="Calls your app makes to PLANEWARD_BASE_URL/api/v1 show up here as they happen."
        />
      ) : visible.length === 0 ? (
        <EmptyList
          title="No matches"
          description={`Nothing matches "${filter}".`}
        />
      ) : (
        <ul className="divide-border min-h-0 flex-1 divide-y overflow-y-auto">
          {visible.map((entry) => {
            const open = expanded.has(entry.id);
            return (
              <li
                key={entry.id}
                className={cn(entry.missingScope && "bg-danger-muted")}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(entry.id)}
                  className="hover:bg-accent/60 flex w-full flex-col gap-1 px-3 py-2 text-left"
                >
                  <span className="flex w-full items-center gap-2">
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        "text-muted-foreground size-3.5 shrink-0 transition-transform",
                        open && "rotate-90"
                      )}
                    />
                    <span className="w-12 shrink-0 font-mono text-[11px] font-semibold">
                      {entry.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {entry.path}
                      {entry.query ? (
                        <span className="text-muted-foreground">
                          ?{entry.query}
                        </span>
                      ) : null}
                    </span>
                    <Badge tone={statusTone(entry.status)}>
                      {entry.status}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground flex items-center gap-2 pl-5.5 text-[11px]">
                    <span>{formatTime(entry.at)}</span>
                    <span>{Math.round(entry.durationMs)} ms</span>
                    {entry.scope ? (
                      <span className="font-mono">{entry.scope}</span>
                    ) : null}
                  </span>
                  {entry.missingScope ? (
                    <span className="text-danger-foreground pl-5.5 text-xs font-medium">
                      Missing scope: add{" "}
                      <code className="font-mono">{entry.missingScope}</code> to
                      planeward.json scopes
                    </span>
                  ) : null}
                </button>
                {open ? (
                  <div className="flex flex-col gap-2 px-3 pb-3">
                    {entry.route ? (
                      <span className="text-muted-foreground text-xs">
                        Route <code className="font-mono">{entry.route}</code>
                      </span>
                    ) : null}
                    <JsonBlock label="Request body" value={entry.requestBody} />
                    <JsonBlock
                      label="Response body"
                      value={entry.responseBody}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function EmptyList({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-xs text-xs text-pretty">
        {description}
      </p>
    </div>
  );
}
