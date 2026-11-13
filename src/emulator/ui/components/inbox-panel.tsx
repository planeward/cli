import { BellIcon } from "lucide-react";
import { useState } from "react";

import type { FixtureMember, FixtureNotification } from "../../contract";
import {
  INBOX_ALL,
  INBOX_VIEWER,
  inboxCount,
  inboxNotifications,
  inboxRecipient,
  type InboxFilter,
} from "../inbox";
import { EmptyList } from "./requests-panel";
import { cn, formatTime, Select, type Option } from "./ui";

/**
 * Notifications the app sent, newest first: the emulator's stand-in for the
 * community bell. Clicking one opens the app at its path as the recipient.
 */
export function InboxPanel({
  notifications,
  members,
  viewerId,
  activeId,
  busy,
  onOpen,
}: {
  notifications: FixtureNotification[];
  members: FixtureMember[];
  viewerId: string;
  /** The notification the app frame shows now, if any. */
  activeId: string | null;
  busy: boolean;
  onOpen: (notification: FixtureNotification) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>(INBOX_VIEWER);
  const names = new Map(
    members.map((member) => [member.id, member.displayName])
  );
  const nameOf = (memberId: string) => names.get(memberId) ?? memberId;
  const recipient = inboxRecipient(filter, viewerId);
  const visible = inboxNotifications(notifications, recipient);

  const withCount = (label: string, count: number) =>
    count > 0 ? `${label} (${count})` : label;
  const options: Option[] = [
    {
      value: INBOX_VIEWER,
      label: withCount(
        `Current viewer, ${nameOf(viewerId)}`,
        inboxCount(notifications, viewerId)
      ),
    },
    {
      value: INBOX_ALL,
      label: withCount("All members", notifications.length),
    },
    ...members.map((member) => ({
      value: member.id,
      label: withCount(
        member.displayName,
        inboxCount(notifications, member.id)
      ),
    })),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border border-b p-2">
        <Select
          className="w-full"
          aria-label="Show notifications for"
          value={filter}
          options={options}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {notifications.length === 0 ? (
        <EmptyList
          title="No notifications yet"
          description="Call community.notifications.send from your app (scope COMMUNITY_NOTIFICATIONS_WRITE). Each member's notification shows up here; click one to open your app at its path as that member."
        />
      ) : visible.length === 0 && recipient !== null ? (
        <EmptyList
          title={`No notifications for ${nameOf(recipient)}`}
          description={`Your app sent ${notifications.length} to other members. Pick All members to see them.`}
        />
      ) : (
        <ul className="divide-border min-h-0 flex-1 divide-y overflow-y-auto">
          {visible.map((notification) => {
            const active = notification.id === activeId;
            const name = nameOf(notification.memberId);
            return (
              <li
                key={notification.id}
                className={cn(active && "bg-accent/50")}
              >
                <button
                  type="button"
                  disabled={busy}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onOpen(notification)}
                  className="hover:bg-accent/60 focus-visible:ring-foreground/30 flex w-full flex-col gap-1 px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset disabled:opacity-50"
                >
                  <span className="flex w-full items-center gap-2">
                    <BellIcon
                      aria-hidden
                      className="text-muted-foreground size-3.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {notification.title}
                    </span>
                    <time
                      dateTime={notification.createdAt}
                      title={new Date(notification.createdAt).toLocaleString()}
                      className="text-muted-foreground shrink-0 text-[11px]"
                    >
                      {formatTime(notification.createdAt)}
                    </time>
                  </span>
                  {/* Plain text: rendered as a text node, never as Markdown or HTML. */}
                  <span className="pl-5.5 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {notification.body}
                  </span>
                  <span className="text-muted-foreground flex min-w-0 items-center gap-2 pl-5.5 text-[11px]">
                    <span className="shrink-0">To {name}</span>
                    <span className="min-w-0 truncate font-mono">
                      {notification.path}
                    </span>
                  </span>
                  <span className="sr-only">
                    Open the app at this path as {name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
