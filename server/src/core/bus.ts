import type { EventPayloads, EventType } from '@pjgen/shared';
import type { EventsRepo } from '../db/repos/events.js';

export interface BusSubscriber {
  /** null → global channel (receives everything); otherwise only that project's events + global events. */
  projectId: string | null;
  fn: (id: number, type: EventType, projectId: string | null, payload: object) => void;
}

/** Persists every event (rowid = SSE Last-Event-ID) then fans out to live SSE subscribers. */
export class Bus {
  private subscribers = new Set<BusSubscriber>();

  constructor(private events: EventsRepo) {}

  emit<T extends EventType>(type: T, projectId: string | null, payload: EventPayloads[T]): number {
    const row = this.events.insert(type, projectId, payload as object);
    this.fanout(row.id, type, projectId, payload as object);
    return row.id;
  }

  /**
   * Fan out to live subscribers WITHOUT persisting (no replay): for high-frequency streams like
   * app logs that must not bloat the events table. Reuses the last persisted id so SSE clients'
   * Last-Event-ID tracking is unaffected.
   */
  emitTransient<T extends EventType>(type: T, projectId: string | null, payload: EventPayloads[T]): void {
    this.fanout(this.events.lastId(), type, projectId, payload as object);
  }

  private fanout(id: number, type: EventType, projectId: string | null, payload: object): void {
    for (const sub of this.subscribers) {
      if (sub.projectId === null || projectId === null || sub.projectId === projectId) {
        try {
          sub.fn(id, type, projectId, payload);
        } catch {
          /* a broken subscriber must not break the emitter */
        }
      }
    }
  }

  subscribe(sub: BusSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
