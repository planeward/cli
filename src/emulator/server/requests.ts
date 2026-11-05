import type { ApiRequestLogEntry } from "../contract";
import type { EmulatorBus } from "./store";

const MAX_ENTRIES = 500;

/** Every `/api/v1` call the app made, newest last; streamed as it happens. */
export class RequestLog {
  readonly #bus: EmulatorBus;
  #entries: ApiRequestLogEntry[] = [];
  #seq = 0;

  constructor(bus: EmulatorBus) {
    this.#bus = bus;
  }

  nextId(): string {
    this.#seq += 1;
    return `request_${this.#seq}`;
  }

  record(entry: ApiRequestLogEntry) {
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) {
      this.#entries = this.#entries.slice(-MAX_ENTRIES);
    }
    this.#bus.emit({ type: "request", entry });
  }

  /** Entries after the one with id `after` (all when unknown or absent). */
  list(after?: string | null): ApiRequestLogEntry[] {
    if (!after) return [...this.#entries];
    const index = this.#entries.findIndex((entry) => entry.id === after);
    return index === -1 ? [...this.#entries] : this.#entries.slice(index + 1);
  }
}
