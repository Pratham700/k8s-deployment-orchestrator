import { EventEmitter } from 'node:events';
import type { Run } from './types';

/**
 * In-memory run store with a pub/sub channel.
 *
 * Runs are held by reference: the engine mutates a Run in place and calls
 * `touch()` to stamp `updatedAt` and notify subscribers. That is what powers
 * the Server-Sent Events stream the UI listens to. A real deployment would
 * swap this for Postgres/Redis behind the same small interface.
 */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent SSE clients may subscribe to the same run.
    this.emitter.setMaxListeners(0);
  }

  create(run: Run): void {
    this.runs.set(run.id, run);
    this.emitter.emit(run.id, run);
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  list(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Stamp the run as updated and notify subscribers. */
  touch(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.updatedAt = new Date().toISOString();
    this.emitter.emit(id, run);
  }

  /** Subscribe to updates for a single run. Returns an unsubscribe function. */
  subscribe(id: string, listener: (run: Run) => void): () => void {
    this.emitter.on(id, listener);
    return () => {
      this.emitter.off(id, listener);
    };
  }
}
