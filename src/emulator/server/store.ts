import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppTheme, AppView } from "@planeward/sdk";

import type {
  EmulatorApp,
  EmulatorEntities,
  EmulatorState,
  EmulatorStreamEvent,
  EmulatorViewer,
} from "../contract";
import { APP_CHANNEL_ID, appChannel, createSeedEntities } from "./fixtures";
import { ensureStateDir } from "./state-dir";

export const STATE_FILE_NAME = "state.json";

const STATE_VERSION = 2;

/** What `<stateDir>/state.json` holds; `app` is rebuilt from the manifest each start. */
type PersistedState = {
  version: typeof STATE_VERSION;
  /** ISO 8601; `app.installed`'s `installedAt`. */
  installedAt: string;
  /** Counter behind ids created at runtime. */
  seq: number;
  viewer: EmulatorViewer;
  view: AppView;
  theme: AppTheme;
  entities: EmulatorEntities;
};

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PersistedState>;
  return (
    state.version === STATE_VERSION &&
    typeof state.installedAt === "string" &&
    typeof state.seq === "number" &&
    Boolean(state.viewer) &&
    Boolean(state.entities) &&
    Array.isArray(state.entities?.members)
  );
}

type Listener = (event: EmulatorStreamEvent) => void;

/** Fan-out of stream events to SSE subscribers. */
export class EmulatorBus {
  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: EmulatorStreamEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not break the emulator.
      }
    }
  }
}

export type EmulatorStoreOptions = {
  app: EmulatorApp;
  /** Null keeps state in memory only (tests). */
  stateDir: string | null;
  bus: EmulatorBus;
  now: () => Date;
  persistDebounceMs?: number;
};

/**
 * In-memory store seeded from fixtures, persisted (debounced) to
 * `<stateDir>/state.json` after every change.
 */
export class EmulatorStore {
  readonly app: EmulatorApp;
  readonly #stateDir: string | null;
  readonly #bus: EmulatorBus;
  readonly #now: () => Date;
  readonly #debounceMs: number;
  #state: PersistedState;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();

  private constructor(options: EmulatorStoreOptions, state: PersistedState) {
    this.app = options.app;
    this.#stateDir = options.stateDir;
    this.#bus = options.bus;
    this.#now = options.now;
    this.#debounceMs = options.persistDebounceMs ?? 150;
    this.#state = state;
  }

  /** Loads `state.json` unless `reset`; `fresh` is true when it seeded instead. */
  static async open(
    options: EmulatorStoreOptions & { reset: boolean }
  ): Promise<{ store: EmulatorStore; fresh: boolean }> {
    let loaded: PersistedState | null = null;
    if (options.stateDir && !options.reset) {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(options.stateDir, STATE_FILE_NAME), "utf8")
        );
        if (isPersistedState(parsed)) loaded = parsed;
      } catch {
        loaded = null;
      }
    }

    const store = new EmulatorStore(
      options,
      loaded ?? seedState(options.app, options.now())
    );
    if (loaded) store.#syncAppChannel();
    store.#schedulePersist();
    return { store, fresh: !loaded };
  }

  get entities(): EmulatorEntities {
    return this.#state.entities;
  }

  get installedAt(): string {
    return this.#state.installedAt;
  }

  get viewer(): EmulatorViewer {
    return this.#state.viewer;
  }

  set viewer(viewer: EmulatorViewer) {
    this.#state.viewer = viewer;
  }

  get view(): AppView {
    return this.#state.view;
  }

  set view(view: AppView) {
    this.#state.view = view;
  }

  get theme(): AppTheme {
    return this.#state.theme;
  }

  set theme(theme: AppTheme) {
    this.#state.theme = theme;
  }

  now(): Date {
    return this.#now();
  }

  nowIso(): string {
    return this.#now().toISOString();
  }

  /** A new id, unique within this state, e.g. `msg_local_12`. */
  nextId(prefix: string): string {
    this.#state.seq += 1;
    return `${prefix}_local_${this.#state.seq}`;
  }

  snapshot(): EmulatorState {
    return {
      app: this.app,
      viewer: this.#state.viewer,
      view: this.#state.view,
      theme: this.#state.theme,
      entities: this.#state.entities,
    };
  }

  /** Call after every mutation: persists (debounced) and streams the new state. */
  changed() {
    this.#schedulePersist();
    this.#bus.emit({ type: "state", state: this.snapshot() });
  }

  /** Reseeds every entity and the viewer; keeps `installedAt`. */
  reset() {
    const seeded = seedState(this.app, this.#now());
    this.#state = { ...seeded, installedAt: this.#state.installedAt };
    this.changed();
  }

  /** Writes pending state now. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#write();
    }
    await this.#writing;
  }

  /** Keeps the APP channel in step with the manifest's name and slug. */
  #syncAppChannel() {
    const channels = this.#state.entities.channels;
    const next = appChannel(this.app);
    const index = channels.findIndex(
      (channel) => channel.id === APP_CHANNEL_ID
    );
    if (index === -1) channels.push(next);
    else
      channels[index] = {
        ...channels[index]!,
        name: next.name,
        slug: next.slug,
      };
  }

  #schedulePersist() {
    if (!this.#stateDir || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, this.#debounceMs);
    this.#timer.unref?.();
  }

  #write() {
    const stateDir = this.#stateDir;
    if (!stateDir) return;
    const body = `${JSON.stringify(this.#state, null, 2)}\n`;
    this.#writing = this.#writing.then(async () => {
      try {
        await ensureStateDir(stateDir);
        const path = join(stateDir, STATE_FILE_NAME);
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, path);
      } catch (error) {
        process.stderr.write(
          `planeward: could not save emulator state: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    });
  }
}

function seedState(app: EmulatorApp, now: Date): PersistedState {
  const entities = createSeedEntities({
    app,
    workspaceId: app.workspaceId,
    now,
  });
  // The first active member without a staff role.
  const viewer =
    entities.members.find(
      (member) => member.status === "ACTIVE" && member.roles.length === 0
    ) ?? entities.members[0]!;
  return {
    version: STATE_VERSION,
    installedAt: now.toISOString(),
    seq: 0,
    viewer: { memberId: viewer.id, role: "member" },
    view: "experience",
    theme: "light",
    entities,
  };
}
