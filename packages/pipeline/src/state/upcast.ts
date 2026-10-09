// Event upcasting (B 4): the one place an old event version becomes the current one.
//
// Events are never edited or deleted. A stored row keeps the `v` and payload it was written with;
// readers that fold events (rebuild.ts today) pass each one through `upcast` first, which applies
// the registered upcasters for the event's type from its `v` up, one version at a time, and returns
// a new event. The stored row is untouched.
//
// Registering an upcaster: when an event type's payload changes shape, bump the `v` its writer
// stamps and register the step from the old version here, in this file, next to the others:
//
//   upcasters.register('filed', 1, (payload) => {
//     const p = payload as { key: string };
//     return { jiraKey: p.key };
//   });
//
// An upcaster is pure: it maps one payload to the next version's payload and reads nothing else.
// Tests that need a private set of upcasters build one with `createUpcasters()` and pass it to
// `upcast` or `rebuild` instead of touching the default registry.

import type { EventType, IncidentEvent } from '../contracts/events.ts';

/** An event as stored, before upcasting: its payload has whatever shape version `v` had. */
export type StoredEvent = Omit<IncidentEvent, 'payload'> & { payload: unknown };

/** Maps the payload of version `fromV` to the payload of version `fromV + 1`. Pure. */
export type Upcaster = (payload: unknown, event: StoredEvent) => unknown;

export interface UpcasterRegistry {
  /**
   * Registers the step from `fromV` to `fromV + 1` for `type`. Rejects a second step for the same
   * `(type, fromV)`. Returns a function that removes it.
   */
  register(type: EventType, fromV: number, fn: Upcaster): () => void;
  /** The step from `fromV` for `type`, if one is registered. */
  get(type: EventType, fromV: number): Upcaster | undefined;
}

export function createUpcasters(): UpcasterRegistry {
  const steps = new Map<string, Upcaster>();
  const key = (type: EventType, fromV: number): string => `${type}@${fromV}`;
  return {
    register(type, fromV, fn) {
      if (!Number.isSafeInteger(fromV) || fromV < 1) {
        throw new RangeError(`upcast: fromV must be a positive integer, got ${String(fromV)}`);
      }
      const k = key(type, fromV);
      if (steps.has(k)) {
        throw new Error(`upcast: an upcaster for ${type} v${fromV} is already registered`);
      }
      steps.set(k, fn);
      return () => {
        if (steps.get(k) === fn) {
          steps.delete(k);
        }
      };
    },
    get(type, fromV) {
      return steps.get(key(type, fromV));
    },
  };
}

/** The registry every reader uses by default. Production upcasters are registered on it here. */
export const upcasters: UpcasterRegistry = createUpcasters();

// `review-passed` v1 to v2 (#264): v2 adds `headSha`, the commit the review approved. A v1 review never
// recorded one, so the step adds none and the payload is otherwise the same: readers treat a review
// without `headSha` as approving no head, and the merge step asks for a fresh review instead of merging.
upcasters.register('review-passed', 1, (payload) => payload);

/**
 * `event` at the newest version its type has an upcaster chain for. Returns `event` itself when no
 * step applies, otherwise a new object with the upcast payload and `v`; never mutates `event`.
 */
export function upcast(event: IncidentEvent | StoredEvent, registry: UpcasterRegistry = upcasters): IncidentEvent {
  let current: StoredEvent = event;
  for (let step = registry.get(current.type, current.v); step !== undefined; step = registry.get(current.type, current.v)) {
    current = { ...current, v: current.v + 1, payload: step(current.payload, current) };
  }
  // The registered chain ends at the version the `EventPayloads` type describes; the payload's
  // shape at that version is the upcasters' contract and cannot be checked statically here.
  return current as IncidentEvent;
}
