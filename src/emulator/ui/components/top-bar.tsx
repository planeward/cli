import type { AppTheme, AppView, AppViewerRole } from "@planeward/sdk";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  MoonIcon,
  PanelRightIcon,
  RotateCcwIcon,
  SearchIcon,
  SunIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import type { CommunityMemberStatus, FixtureMember } from "../../contract";
import { Badge, Button, cn, Segmented } from "./ui";

const STATUS_TONE: Record<
  CommunityMemberStatus,
  "success" | "warning" | "danger"
> = {
  ACTIVE: "success",
  SUSPENDED: "warning",
  REVOKED: "danger",
};

export function MemberStatusBadge({
  status,
}: {
  status: CommunityMemberStatus;
}) {
  return <Badge tone={STATUS_TONE[status]}>{status.toLowerCase()}</Badge>;
}

export function TopBar({
  appName,
  members,
  viewerId,
  role,
  view,
  theme,
  busy,
  panelOpen,
  onViewerChange,
  onRoleChange,
  onThemeChange,
  onReset,
  onTogglePanel,
}: {
  appName: string;
  members: FixtureMember[];
  viewerId: string;
  role: AppViewerRole;
  view: AppView;
  theme: AppTheme;
  busy: boolean;
  panelOpen: boolean;
  onViewerChange: (memberId: string) => void;
  onRoleChange: (role: AppViewerRole) => void;
  onThemeChange: (theme: AppTheme) => void;
  onReset: () => Promise<void>;
  onTogglePanel: () => void;
}) {
  const dashboard = view === "dashboard";
  const roleHintId = useId();
  return (
    <header className="border-border bg-surface flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md text-xs font-bold">
          P
        </span>
        <span className="truncate text-sm font-semibold">{appName}</span>
        <Badge>local</Badge>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-muted-foreground hidden text-xs sm:inline">
          Viewing as
        </span>
        <ViewerSwitcher
          members={members}
          viewerId={viewerId}
          disabled={busy}
          onChange={onViewerChange}
        />
        <Segmented<AppViewerRole>
          label="Viewer role"
          describedBy={dashboard ? roleHintId : undefined}
          value={dashboard ? "admin" : role}
          disabled={busy || dashboard}
          onChange={onRoleChange}
          options={[
            { value: "member", label: "Member" },
            { value: "admin", label: "Admin" },
          ]}
        />
        {dashboard ? (
          <span
            id={roleHintId}
            className="text-muted-foreground max-w-28 text-[11px] leading-tight"
          >
            Dashboard always opens as admin
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
          }
          title="Toggle theme"
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <SunIcon className="size-4" aria-hidden />
          ) : (
            <MoonIcon className="size-4" aria-hidden />
          )}
        </Button>
        <ResetButton onReset={onReset} />
        <Button
          variant="ghost"
          size="icon"
          aria-label={panelOpen ? "Hide dev panel" : "Show dev panel"}
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
        >
          <PanelRightIcon className="size-4" aria-hidden />
        </Button>
      </div>
    </header>
  );
}

type DismissReason = "escape" | "outside" | "select";

function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: (reason: DismissReason) => void
) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        close("outside");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close("escape");
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}

function ViewerSwitcher({
  members,
  viewerId,
  disabled,
  onChange,
}: {
  members: FixtureMember[];
  viewerId: string;
  disabled: boolean;
  onChange: (memberId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const viewer = members.find((member) => member.id === viewerId);
  const viewerName = viewer?.displayName ?? "Pick a member";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return members;
    }
    return members.filter((member) =>
      [member.displayName, member.username ?? "", member.email, member.status]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [members, query]);

  const close = useCallback((reason?: DismissReason) => {
    setOpen(false);
    setQuery("");
    if (reason !== "outside") {
      triggerRef.current?.focus();
    }
  }, []);
  useDismiss(open, rootRef, close);

  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function show() {
    setActive(
      Math.max(
        members.findIndex((member) => member.id === viewerId),
        0
      )
    );
    setOpen(true);
  }

  function choose(member: FixtureMember | undefined) {
    if (!member) {
      return;
    }
    close("select");
    if (member.id !== viewerId) {
      onChange(member.id);
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        if (
          open &&
          !rootRef.current?.contains(event.relatedTarget as Node | null)
        ) {
          close("outside");
        }
      }}
    >
      <Button
        ref={triggerRef}
        className="w-56 justify-between"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Viewing as ${viewerName}`}
        onClick={() => (open ? close("select") : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={viewer?.displayName ?? "?"} />
          <span className="truncate">{viewerName}</span>
        </span>
        <ChevronsUpDownIcon
          className="text-muted-foreground size-3.5"
          aria-hidden
        />
      </Button>
      {open ? (
        <div className="border-border bg-surface absolute top-full right-0 z-30 mt-1 w-80 overflow-hidden rounded-lg border shadow-lg">
          <div className="border-border flex items-center gap-2 border-b px-2.5">
            <SearchIcon
              className="text-muted-foreground size-3.5 shrink-0"
              aria-hidden
            />
            <input
              autoFocus
              role="combobox"
              aria-controls={listId}
              aria-expanded
              aria-label="Search members"
              aria-activedescendant={
                filtered[active]
                  ? `${listId}-${filtered[active].id}`
                  : undefined
              }
              placeholder="Search name, email or status…"
              className="h-9 w-full bg-transparent text-sm outline-none"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) =>
                    Math.min(index + 1, Math.max(filtered.length - 1, 0))
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(filtered[active]);
                }
              }}
            />
          </div>
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Members"
            className="max-h-80 overflow-y-auto p-1"
            // Keep focus in the search box so a click doesn't count as focus leaving.
            onMouseDown={(event) => event.preventDefault()}
          >
            {filtered.length === 0 ? (
              <li className="text-muted-foreground px-2 py-6 text-center text-sm">
                No members match “{query}”.
              </li>
            ) : (
              filtered.map((member, index) => (
                <li
                  key={member.id}
                  id={`${listId}-${member.id}`}
                  data-index={index}
                  role="option"
                  aria-selected={member.id === viewerId}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(member)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === active && "bg-accent"
                  )}
                >
                  <Avatar name={member.displayName} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{member.displayName}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {member.email}
                    </span>
                  </span>
                  <MemberStatusBadge status={member.status} />
                  <CheckIcon
                    aria-hidden
                    className={cn(
                      "size-3.5",
                      member.id === viewerId ? "opacity-100" : "opacity-0"
                    )}
                  />
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className="bg-muted text-muted-foreground grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold"
    >
      {initials || "?"}
    </span>
  );
}

/** "Reset data" with an in-page confirm (no `window.confirm`). */
function ResetButton({ onReset }: { onReset: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = useCallback((reason?: DismissReason) => {
    setOpen(false);
    setError(null);
    if (reason !== "outside") {
      triggerRef.current?.focus();
    }
  }, []);
  useDismiss(open && !pending, rootRef, close);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onReset();
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reset failed.");
    } finally {
      setPending(false);
    }
  }

  /** Keeps Tab inside the confirm while it's open. */
  function trapTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !panelRef.current) {
      return;
    }
    const focusable = [
      ...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled)"
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <RotateCcwIcon className="size-3.5" aria-hidden />
        Reset data
      </Button>
      {open ? (
        <div
          ref={panelRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onKeyDown={trapTab}
          className="border-border bg-surface absolute top-full right-0 z-30 mt-1 flex w-72 flex-col gap-3 rounded-lg border p-3 shadow-lg"
        >
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-sm font-semibold">
              Reset emulator data?
            </h2>
            <p
              id={descriptionId}
              className="text-muted-foreground text-xs text-pretty"
            >
              Reseeds members, channels, messages, courses, events and forms.
              Everything the app or the Activity panel changed is lost.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-danger-foreground text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => close()}
              autoFocus
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={confirm}
            >
              {pending ? "Resetting…" : "Reset data"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
