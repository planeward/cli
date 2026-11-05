import { useId, useState, type ReactNode } from "react";

import type {
  ActivityAction,
  ActivityResult,
  AttendanceStatus,
  EmulatorState,
  FixtureMember,
  WebhookDeliveryEntry,
} from "../../contract";
import { EmulatorApiError } from "../api";
import {
  Badge,
  Button,
  cn,
  ErrorText,
  Field,
  Input,
  Select,
  Textarea,
  type Option,
} from "./ui";
import { DeliveryStatusBadge } from "./webhooks-panel";

const ATTENDANCE: AttendanceStatus[] = [
  "PENDING",
  "ATTENDED",
  "LEFT_EARLY",
  "NO_SHOW",
  "UNCLASSIFIED",
];

type LogEntry = {
  id: number;
  type: ActivityAction["type"];
  events: string[];
  deliveryIds: string[];
  error: string | null;
};

/** Results shown before "Show all", so the forms stay in view. */
const RECENT_RESULTS = 3;

const truncate = (text: string, length = 48) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const memberOptions = (members: FixtureMember[]): Option[] =>
  members.map((member) => ({
    value: member.id,
    label: `${member.displayName} (${member.status.toLowerCase()})`,
  }));

/** Act as a member (the current viewer by default) to change data and fire webhooks. */
export function ActivityPanel({
  state,
  deliveries,
  run,
  onShowDelivery,
}: {
  state: EmulatorState;
  deliveries: Map<string, WebhookDeliveryEntry>;
  run: (action: ActivityAction) => Promise<ActivityResult>;
  onShowDelivery: (deliveryId: string) => void;
}) {
  const { entities, viewer, app } = state;
  const [actorOverride, setActorOverride] = useState<{
    viewerId: string;
    memberId: string;
  } | null>(null);
  const actorId =
    actorOverride?.viewerId === viewer.memberId
      ? actorOverride.memberId
      : viewer.memberId;
  const actor = entities.members.find((member) => member.id === actorId);

  const [pending, setPending] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [nextId, setNextId] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? log : log.slice(0, RECENT_RESULTS);

  async function submit(action: ActivityAction): Promise<boolean> {
    setPending(action.type);
    const id = nextId;
    setNextId(id + 1);
    try {
      const result = await run(action);
      setLog((entries) =>
        [
          {
            id,
            type: action.type,
            events: result.events,
            deliveryIds: result.deliveryIds,
            error: null,
          },
          ...entries,
        ].slice(0, 30)
      );
      return true;
    } catch (cause) {
      setLog((entries) =>
        [
          {
            id,
            type: action.type,
            events: [],
            deliveryIds: [],
            error:
              cause instanceof EmulatorApiError || cause instanceof Error
                ? cause.message
                : "Action failed.",
          },
          ...entries,
        ].slice(0, 30)
      );
      return false;
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const common = { actorId, busy, submit };

  return (
    <div className="flex flex-col gap-3 p-3">
      <Field label="Act as">
        {(id) => (
          <Select
            id={id}
            value={actorId}
            options={memberOptions(entities.members).map((option) =>
              option.value === viewer.memberId
                ? { ...option, label: `${option.label}, current viewer` }
                : option
            )}
            onChange={(event) =>
              setActorOverride({
                viewerId: viewer.memberId,
                memberId: event.target.value,
              })
            }
          />
        )}
      </Field>

      {/* The live list stays mounted (visually hidden while empty) so the first result is announced too. */}
      <section
        aria-label="Results"
        className={
          log.length > 0
            ? "border-border bg-surface flex flex-col gap-2.5 rounded-lg border p-3"
            : "contents"
        }
      >
        {log.length > 0 ? (
          <h3 className="text-sm font-semibold">Results</h3>
        ) : null}
        <ul
          aria-live="polite"
          className={cn("flex flex-col gap-2", log.length === 0 && "sr-only")}
        >
          {shown.map((entry) => (
            <li
              key={entry.id}
              className="border-border flex flex-col gap-1.5 rounded-md border p-2"
            >
              <div className="flex items-center gap-2">
                <code className="font-mono text-xs font-medium">
                  {entry.type}
                </code>
                {entry.error ? (
                  <Badge tone="danger">error</Badge>
                ) : entry.events.length === 0 ? (
                  <Badge>no change</Badge>
                ) : null}
              </div>
              {entry.error ? <ErrorText>{entry.error}</ErrorText> : null}
              {entry.events.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {entry.events.map((event, index) => (
                    <Badge key={`${event}-${index}`}>{event}</Badge>
                  ))}
                </div>
              ) : null}
              {entry.deliveryIds.map((deliveryId) => {
                const delivery = deliveries.get(deliveryId);
                return (
                  <button
                    key={deliveryId}
                    type="button"
                    onClick={() => onShowDelivery(deliveryId)}
                    className="hover:bg-accent flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs"
                  >
                    <span className="text-muted-foreground truncate font-mono">
                      {deliveryId}
                    </span>
                    {delivery ? (
                      <DeliveryStatusBadge status={delivery.status} />
                    ) : null}
                  </button>
                );
              })}
            </li>
          ))}
        </ul>
        {log.length > RECENT_RESULTS ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${log.length}`}
          </Button>
        ) : null}
      </section>

      {actor ? (
        <>
          <MessageForms {...common} state={state} />
          <ModuleForm {...common} state={state} />
          <EventForm {...common} state={state} actor={actor} />
          <FormSubmitForm {...common} state={state} actor={actor} />
        </>
      ) : (
        <ErrorText>Pick a member to act as.</ErrorText>
      )}
      <MembershipForm {...common} state={state} />
      <p className="text-muted-foreground text-xs">
        Webhooks go to{" "}
        {app.webhookUrl ?? "nowhere: no webhookPath in planeward.json"}.
      </p>
    </div>
  );
}

type FormProps = {
  actorId: string;
  busy: boolean;
  submit: (action: ActivityAction) => Promise<boolean>;
  state: EmulatorState;
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-surface flex flex-col gap-2.5 rounded-lg border p-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? (
          <p className="text-muted-foreground text-xs">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-end gap-2">{children}</div>;
}

/** Keeps a selection valid when the list changes (e.g. after a reset). */
function pick(selected: string, options: Option[]): string {
  return options.some((option) => option.value === selected && !option.disabled)
    ? selected
    : (options.find((option) => !option.disabled)?.value ?? "");
}

function MessageForms({ actorId, busy, submit, state }: FormProps) {
  const { entities } = state;
  const channelOptions: Option[] = [...entities.channels]
    .filter((channel) => channel.kind === "TEXT")
    .sort((a, b) => a.position - b.position)
    .map((channel) => ({
      value: channel.id,
      label: `#${channel.name}${channel.everyone.view ? "" : " (private)"}`,
    }));
  const [channelChoice, setChannelChoice] = useState("");
  const channelId = pick(channelChoice, channelOptions);
  const [body, setBody] = useState("");
  const messages = entities.messages
    .filter((message) => message.channelId === channelId && !message.deletedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const messageOptions: Option[] = messages.map((message) => ({
    value: message.id,
    label: `${message.author.name}: ${truncate(message.body)}`,
  }));
  const [messageChoice, setMessageChoice] = useState("");
  const messageId = pick(messageChoice, messageOptions);
  const message = messages.find((item) => item.id === messageId);
  const [emoji, setEmoji] = useState("👍");
  const actorReacted = Boolean(
    message?.reactions.some(
      (reaction) => reaction.memberId === actorId && reaction.emoji === emoji
    )
  );

  return (
    <Section
      title="Messages"
      description="Post, react and delete in a seeded text channel."
    >
      <Field label="Channel">
        {(id) => (
          <Select
            id={id}
            value={channelId}
            options={channelOptions}
            onChange={(event) => setChannelChoice(event.target.value)}
          />
        )}
      </Field>
      <form
        className="flex items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!body.trim() || !channelId) {
            return;
          }
          const ok = await submit({
            type: "message.post",
            memberId: actorId,
            channelId,
            body: body.trim(),
          });
          if (ok) {
            setBody("");
          }
        }}
      >
        <Field label="Message">
          {(id) => (
            <Input
              id={id}
              value={body}
              placeholder="Say something…"
              onChange={(event) => setBody(event.target.value)}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !body.trim() || !channelId}
        >
          Post
        </Button>
      </form>

      <Field label="Existing message">
        {(id) => (
          <Select
            id={id}
            value={messageId}
            options={messageOptions}
            placeholder={messages.length ? undefined : "No messages yet"}
            disabled={messages.length === 0}
            onChange={(event) => setMessageChoice(event.target.value)}
          />
        )}
      </Field>
      {message && message.reactions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {Object.entries(
            message.reactions.reduce<Record<string, number>>(
              (counts, reaction) => ({
                ...counts,
                [reaction.emoji]: (counts[reaction.emoji] ?? 0) + 1,
              }),
              {}
            )
          ).map(([value, count]) => (
            <Badge key={value}>
              {value} {count}
            </Badge>
          ))}
        </div>
      ) : null}
      <Row>
        <Field label="Emoji">
          {(id) => (
            <Input
              id={id}
              value={emoji}
              className="w-20"
              onChange={(event) => setEmoji(event.target.value)}
            />
          )}
        </Field>
        <Button
          disabled={busy || !message || !emoji || actorReacted}
          onClick={() =>
            submit({
              type: "reaction.add",
              memberId: actorId,
              messageId,
              emoji,
            })
          }
        >
          React
        </Button>
        <Button
          disabled={busy || !message || !emoji || !actorReacted}
          onClick={() =>
            submit({
              type: "reaction.remove",
              memberId: actorId,
              messageId,
              emoji,
            })
          }
        >
          Unreact
        </Button>
        <Button
          variant="ghost"
          className="text-danger-foreground"
          disabled={busy || !message}
          onClick={() => submit({ type: "message.delete", messageId })}
        >
          Delete
        </Button>
      </Row>
    </Section>
  );
}

function ModuleForm({ actorId, busy, submit, state }: FormProps) {
  const { entities } = state;
  const modules = entities.courses.flatMap((course) =>
    course.chapters.flatMap((chapter) =>
      chapter.modules.map((module) => ({
        module,
        label: `${course.title} › ${chapter.title} › ${module.title}${course.publishedAt ? "" : " (unpublished)"}`,
      }))
    )
  );
  const options: Option[] = modules.map(({ module, label }) => ({
    value: module.id,
    label,
  }));
  const [choice, setChoice] = useState("");
  const moduleId = pick(choice, options);
  const progress = entities.progress.find(
    (entry) => entry.memberId === actorId && entry.moduleId === moduleId
  );
  const completed = Boolean(progress?.completedAt);

  return (
    <Section title="Course progress">
      <Field label="Module">
        {(id) => (
          <Select
            id={id}
            value={moduleId}
            options={options}
            placeholder={options.length ? undefined : "No courses seeded"}
            onChange={(event) => setChoice(event.target.value)}
          />
        )}
      </Field>
      <Row>
        <span className="text-muted-foreground flex-1 text-xs">
          {moduleId
            ? completed
              ? "Completed by this member."
              : "Not completed by this member."
            : null}
        </span>
        <Button
          disabled={busy || !moduleId || completed}
          onClick={() =>
            submit({ type: "module.complete", memberId: actorId, moduleId })
          }
        >
          Complete
        </Button>
        <Button
          disabled={busy || !moduleId || !completed}
          onClick={() =>
            submit({ type: "module.uncomplete", memberId: actorId, moduleId })
          }
        >
          Uncomplete
        </Button>
      </Row>
    </Section>
  );
}

function EventForm({
  actorId,
  busy,
  submit,
  state,
  actor,
}: FormProps & { actor: FixtureMember }) {
  const { entities } = state;
  const options: Option[] = entities.events.map((event) => ({
    value: event.id,
    label: `${event.name}${event.showInCommunity ? "" : " (not shown in community)"}`,
  }));
  const [choice, setChoice] = useState("");
  const eventId = pick(choice, options);
  const event = entities.events.find((item) => item.id === eventId);
  const registration =
    actor.contactId && event
      ? event.registrations.find((item) => item.contactId === actor.contactId)
      : undefined;
  const [attendance, setAttendance] = useState<AttendanceStatus>("ATTENDED");

  return (
    <Section
      title="Events"
      description="Only events shown in community send webhooks to apps."
    >
      <Field label="Event">
        {(id) => (
          <Select
            id={id}
            value={eventId}
            options={options}
            placeholder={options.length ? undefined : "No events seeded"}
            onChange={(change) => setChoice(change.target.value)}
          />
        )}
      </Field>
      <Row>
        <span className="text-muted-foreground flex-1 text-xs">
          {registration
            ? `Registered, attendance ${registration.attendance.toLowerCase()}.`
            : eventId
              ? "Not registered."
              : null}
        </span>
        <Button
          disabled={busy || !eventId || Boolean(registration)}
          onClick={() =>
            submit({ type: "event.rsvp", memberId: actorId, eventId })
          }
        >
          RSVP
        </Button>
        <Button
          disabled={busy || !registration}
          onClick={() =>
            submit({ type: "event.cancel_rsvp", memberId: actorId, eventId })
          }
        >
          Cancel RSVP
        </Button>
      </Row>
      <Row>
        <Field label="Attendance">
          {(id) => (
            <Select
              id={id}
              value={attendance}
              options={ATTENDANCE.map((value) => ({ value, label: value }))}
              onChange={(change) =>
                setAttendance(change.target.value as AttendanceStatus)
              }
            />
          )}
        </Field>
        <Button
          disabled={busy || !registration}
          onClick={() =>
            submit({
              type: "event.attendance",
              memberId: actorId,
              eventId,
              attendance,
            })
          }
        >
          Set attendance
        </Button>
      </Row>
    </Section>
  );
}

function FormSubmitForm({
  actorId,
  busy,
  submit,
  state,
  actor,
}: FormProps & { actor: FixtureMember }) {
  const { entities } = state;
  const options: Option[] = entities.forms.map((form) => ({
    value: form.id,
    label: form.showInCommunity
      ? form.name
      : `${form.name} (not shown in community)`,
    disabled: !form.showInCommunity || form.status !== "PUBLISHED",
  }));
  const [choice, setChoice] = useState("");
  const formId = pick(choice, options);
  const defaultFields = JSON.stringify(
    { name: actor.displayName, email: actor.email },
    null,
    2
  );
  const [draft, setDraft] = useState<{ actorId: string; text: string } | null>(
    null
  );
  const parseErrorId = useId();
  const text = draft?.actorId === actorId ? draft.text : defaultFields;
  let fields: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      fields = parsed as Record<string, unknown>;
    } else {
      parseError = "Fields must be a JSON object.";
    }
  } catch {
    parseError = "Fields must be valid JSON.";
  }

  return (
    <Section
      title="Form submission"
      description="Only published forms shown in community can be submitted from the host."
    >
      <Field label="Form">
        {(id) => (
          <Select
            id={id}
            value={formId}
            options={options}
            placeholder={
              options.some((option) => !option.disabled)
                ? undefined
                : "No flagged forms"
            }
            onChange={(event) => setChoice(event.target.value)}
          />
        )}
      </Field>
      <Field label="Fields (JSON)">
        {(id) => (
          <Textarea
            id={id}
            rows={4}
            value={text}
            spellCheck={false}
            aria-invalid={Boolean(parseError)}
            aria-describedby={parseError ? parseErrorId : undefined}
            onChange={(event) =>
              setDraft({ actorId, text: event.target.value })
            }
          />
        )}
      </Field>
      {parseError ? (
        <ErrorText id={parseErrorId}>{parseError}</ErrorText>
      ) : null}
      <Row>
        <span className="flex-1" />
        <Button
          disabled={busy || !formId || !fields}
          onClick={() =>
            fields &&
            submit({ type: "form.submit", memberId: actorId, formId, fields })
          }
        >
          Submit form
        </Button>
      </Row>
    </Section>
  );
}

function MembershipForm({ actorId, busy, submit, state }: FormProps) {
  const { entities } = state;
  const [targetChoice, setTargetChoice] = useState<string | null>(null);
  const targetId =
    targetChoice &&
    entities.members.some((member) => member.id === targetChoice)
      ? targetChoice
      : actorId;
  const target = entities.members.find((member) => member.id === targetId);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");

  return (
    <Section
      title="Membership"
      description="Staff actions: change any member's access."
    >
      <Row>
        <Field label="Member">
          {(id) => (
            <Select
              id={id}
              value={targetId}
              options={memberOptions(entities.members)}
              onChange={(event) => setTargetChoice(event.target.value)}
            />
          )}
        </Field>
      </Row>
      <Row>
        <Button
          disabled={busy || target?.status !== "ACTIVE"}
          onClick={() =>
            submit({ type: "membership.suspend", memberId: targetId })
          }
        >
          Suspend
        </Button>
        <Button
          disabled={busy || target?.status !== "SUSPENDED"}
          onClick={() =>
            submit({ type: "membership.resume", memberId: targetId })
          }
        >
          Resume
        </Button>
        <Button
          variant="ghost"
          className="text-danger-foreground"
          disabled={busy || !target || target.status === "REVOKED"}
          onClick={() =>
            submit({ type: "membership.revoke", memberId: targetId })
          }
        >
          Revoke
        </Button>
      </Row>
      <form
        className="flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await submit({
            type: "membership.grant",
            displayName: displayName.trim(),
            email: email.trim(),
          });
          if (ok) {
            setDisplayName("");
            setEmail("");
          }
        }}
      >
        <Row>
          <Field label="New member name">
            {(id) => (
              <Input
                id={id}
                value={displayName}
                autoComplete="off"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
        </Row>
        <Row>
          <span className="flex-1" />
          <Button
            type="submit"
            disabled={busy || !displayName.trim() || !email.trim()}
          >
            Grant membership
          </Button>
        </Row>
      </form>
    </Section>
  );
}
