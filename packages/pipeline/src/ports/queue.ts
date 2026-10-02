// src/ports/queue.ts (main 14.3): the queue runtime port. Local: in-memory
// (providers/local/queue.ts); aws: SQS; gcp: Cloud Tasks; docker: Redis Streams (BullMQ).
//
// Pipeline jobs (incident processing, the fixer run, timers) go through WorkflowPort (B 1), which
// is durable and commits with the state transaction. This port is the plain fire-and-forget queue
// main 14.3 names, for work that needs no durability beyond the provider's own.
//
// The spec's `unknown` payloads become a type parameter: a queue is typed by a map from queue name
// to payload type, so `enqueue` and `consume` agree on the payload of each name. The default map
// keeps the spec's `unknown`.

/** Maps each queue name to the payload type its messages carry. */
export type QueuePayloads = Record<string, unknown>;

export interface EnqueueOptions {
  /** Seconds to wait before the message becomes deliverable. Default 0. */
  delaySec?: number;
}

export interface QueuePort<M extends QueuePayloads = QueuePayloads> {
  /** Enqueues one message on `name` and resolves with the message id. */
  enqueue<N extends keyof M & string>(name: N, payload: M[N], opts?: EnqueueOptions): Promise<string>;
  /**
   * Registers the handler for `name`. Messages are delivered at least once: a handler that rejects
   * may see the same payload again, so handlers must be idempotent.
   */
  consume<N extends keyof M & string>(name: N, handler: (p: M[N]) => Promise<void>): void;
}
