import { ServiceError } from './contracts.js';
import { positiveLimit } from './resourceBudgets.js';

export interface WorkQueueOptions { maxQueued?: number; waitMs?: number }
type Waiting = { start(): void; cancel(error: ServiceError): void };

/** A small FIFO absorbs read bursts without increasing simultaneous provider work. */
export class WorkAdmission {
  active = 0;
  readonly maxQueued: number;
  readonly waitMs: number;
  private stopped = false;
  private readonly waiting = new Set<Waiting>();
  constructor(private readonly maxActive: number, options: WorkQueueOptions = {}) {
    positiveLimit(maxActive, 3);
    this.maxQueued = positiveLimit(options.maxQueued, 3);
    this.waitMs = positiveLimit(options.waitMs, 2000);
  }
  get queued() { return this.waiting.size; }
  async run<T>(operation: () => Promise<T>, mayWait = false, signal?: AbortSignal): Promise<T> {
    if (this.stopped) throw new ServiceError(503, 'SHUTTING_DOWN');
    if (signal?.aborted) throw new ServiceError(409, 'REQUEST_CLOSED');
    if (this.active < this.maxActive) return this.execute(operation);
    if (!mayWait || this.queued >= this.maxQueued) throw new ServiceError(429, 'AT_CAPACITY');
    const deadline = performance.now() + this.waitMs;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const remove = () => {
        this.waiting.delete(entry);
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
      };
      const entry: Waiting = {
        cancel: error => { remove(); reject(error); },
        start: () => {
          remove();
          if (this.stopped) { reject(new ServiceError(503, 'SHUTTING_DOWN')); return; }
          if (signal?.aborted) { reject(new ServiceError(409, 'REQUEST_CLOSED')); return; }
          // Timers can run late. Never dispatch an expired waiter just because
          // its timeout callback has not had a turn on the event loop yet.
          if (performance.now() >= deadline) { reject(new ServiceError(429, 'AT_CAPACITY')); return; }
          void this.execute(operation).then(resolve, reject);
        },
      };
      const aborted = () => entry.cancel(new ServiceError(409, 'REQUEST_CLOSED'));
      timer = setTimeout(() => entry.cancel(new ServiceError(429, 'AT_CAPACITY')), this.waitMs);
      this.waiting.add(entry);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    try { return await operation(); }
    finally {
      // Disconnection does not release work that has already reached a provider.
      this.active--;
      while (!this.stopped && this.active < this.maxActive && this.waiting.size) {
        this.waiting.values().next().value!.start();
      }
    }
  }
  stop() {
    this.stopped = true;
    for (const entry of this.waiting) entry.cancel(new ServiceError(503, 'SHUTTING_DOWN'));
  }
}
