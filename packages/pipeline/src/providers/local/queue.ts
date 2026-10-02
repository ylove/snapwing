// The `local` QueuePort (main 14.3): an in-memory queue for dev and the demo. Nothing survives the
// process; durable pipeline work goes through WorkflowPort instead (B 1).
//
// Semantics, which the cloud providers approximate:
// - Payloads are copied with `structuredClone` on enqueue, as a real queue serializes them, so a
//   producer mutating its object afterwards changes nothing.
// - Delivery is asynchronous (never inside `enqueue` or `consume`), in enqueue order per name, one
//   message at a time per name. Messages enqueued before `consume` wait for it.
// - At least once: a handler that rejects gets the message again after `retryDelaySec`, up to
//   `maxAttempts` deliveries in all; then it moves to `deadLetters`.
// - `delaySec` holds a message back with a timer. Tests use fake timers to move past it.

import type { EnqueueOptions, QueuePayloads, QueuePort } from '../../ports/queue.ts';
import { ulid } from '../../util/ulid.ts';

export interface InMemoryQueueOptions {
  /** Deliveries per message before it is dead-lettered. Default 3. */
  maxAttempts?: number;
  /** Seconds before a failed message is delivered again. Default 1. */
  retryDelaySec?: number;
}

export interface DeadLetter {
  id: string;
  name: string;
  payload: unknown;
  attempts: number;
  error: unknown;
}

interface Message {
  id: string;
  payload: unknown;
  attempts: number;
}

interface Lane {
  ready: Message[];
  handler?: (p: unknown) => Promise<void>;
  pump?: Promise<void> | undefined;
}

export class QueueClosedError extends Error {
  constructor() {
    super('queue is closed');
    this.name = 'QueueClosedError';
  }
}

export class InMemoryQueue<M extends QueuePayloads = QueuePayloads> implements QueuePort<M> {
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #lanes = new Map<string, Lane>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #deadLetters: DeadLetter[] = [];
  #closed = false;

  constructor(options: InMemoryQueueOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryDelayMs = secondsToMs(options.retryDelaySec ?? 1, 'retryDelaySec');
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new RangeError(`maxAttempts must be an integer of at least 1, got ${String(this.#maxAttempts)}`);
    }
  }

  async enqueue<N extends keyof M & string>(name: N, payload: M[N], opts: EnqueueOptions = {}): Promise<string> {
    if (this.#closed) throw new QueueClosedError();
    const delayMs = secondsToMs(opts.delaySec ?? 0, 'delaySec');
    const message: Message = { id: ulid(), payload: structuredClone(payload), attempts: 0 };
    if (delayMs === 0) this.#push(name, message);
    else this.#later(delayMs, () => this.#push(name, message));
    return message.id;
  }

  consume<N extends keyof M & string>(name: N, handler: (p: M[N]) => Promise<void>): void {
    if (this.#closed) throw new QueueClosedError();
    const lane = this.#lane(name);
    if (lane.handler !== undefined) throw new Error(`queue ${name} already has a consumer`);
    // The lane holds payloads as `unknown`; every payload on lane `name` was enqueued as `M[N]`.
    lane.handler = handler as (p: unknown) => Promise<void>;
    this.#pump(name, lane);
  }

  /** Messages that failed `maxAttempts` times, oldest first. */
  get deadLetters(): readonly DeadLetter[] {
    return this.#deadLetters;
  }

  /**
   * Resolves once every consumed lane has no ready message and no delivery in flight. Messages still
   * waiting on a delay or retry timer are not waited for.
   */
  async drain(): Promise<void> {
    for (;;) {
      const pumps = [...this.#lanes.values()].flatMap((l) => (l.pump === undefined ? [] : [l.pump]));
      if (pumps.length === 0) return;
      await Promise.all(pumps);
    }
  }

  /** Stops every timer and drops undelivered messages. Deliveries in flight finish. */
  close(): void {
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    for (const lane of this.#lanes.values()) lane.ready.length = 0;
  }

  #lane(name: string): Lane {
    let lane = this.#lanes.get(name);
    if (lane === undefined) {
      lane = { ready: [] };
      this.#lanes.set(name, lane);
    }
    return lane;
  }

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }

  #push(name: string, message: Message): void {
    if (this.#closed) return;
    const lane = this.#lane(name);
    lane.ready.push(message);
    this.#pump(name, lane);
  }

  #pump(name: string, lane: Lane): void {
    if (lane.pump !== undefined || lane.handler === undefined || lane.ready.length === 0) return;
    const handler = lane.handler;
    lane.pump = (async () => {
      // Never deliver on the caller's stack.
      await Promise.resolve();
      for (let message = lane.ready.shift(); message !== undefined; message = lane.ready.shift()) {
        message.attempts += 1;
        try {
          await handler(structuredClone(message.payload));
        } catch (error) {
          this.#failed(name, message, error);
        }
      }
      lane.pump = undefined;
    })();
  }

  #failed(name: string, message: Message, error: unknown): void {
    if (message.attempts >= this.#maxAttempts) {
      this.#deadLetters.push({ id: message.id, name, payload: message.payload, attempts: message.attempts, error });
      return;
    }
    if (this.#retryDelayMs === 0) this.#lane(name).ready.push(message);
    else this.#later(this.#retryDelayMs, () => this.#push(name, message));
  }
}

function secondsToMs(sec: number, what: string): number {
  if (!Number.isFinite(sec) || sec < 0) throw new RangeError(`${what} must be a finite number of seconds of at least 0, got ${String(sec)}`);
  return Math.round(sec * 1000);
}
