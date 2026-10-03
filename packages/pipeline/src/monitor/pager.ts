// src/monitor/pager.ts (A 6.2, escalation `pagerduty`): the minimal pager interface the escalation
// ladder (#299) calls. The pipeline declares it and never imports an implementation; the app
// implements it (app/src/pager/pagerduty.ts). One dedup key per incident and ladder.

export type PagerSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface PagerTriggerInput {
  /** Stable per incident and ladder; a repeat trigger with the same key updates the same page. */
  dedupKey: string;
  summary: string;
  severity?: PagerSeverity;
  /** What raised the page, for example `snapwing`. */
  source?: string;
  /**
   * The Events API v2 routing key. The ladder (#299) always passes one, read from the secrets port:
   * `PAGERDUTY_ROUTING_KEY_<SERVICE>` for the step's `pagerduty` service id, else
   * `PAGERDUTY_ROUTING_KEY`. The playbook's `pagerduty` value is a service id, never a key.
   */
  routingKey?: string;
  /** A link back to the incident. */
  link?: { href: string; text?: string };
  details?: Record<string, string>;
}

export interface Pager {
  trigger(input: PagerTriggerInput): Promise<void>;
  /** Resolves the page opened under `dedupKey` when the ladder stops. */
  resolve(dedupKey: string, opts?: { routingKey?: string }): Promise<void>;
}
