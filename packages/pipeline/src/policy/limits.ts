// Chat limits (main 16, #272): model work that chat starts is bounded per person, per incident, and
// per day, so a flood of thread replies, direct messages, or trigger reactions cannot run up the bill.
//
// - Sliding windows, in memory and per process (`CHAT_LIMITS`): model passes on chat messages per person
//   and per incident thread, and new incidents per person. The defaults are far above what a team
//   does by hand; only a loop or a flood reaches them.
// - The daily budget counts every call through the server's model port (`countModelCalls`) per UTC day,
//   against the playbook's `<limits modelCallsPerDay>`. Once it is spent no new chat model work starts
//   until the next UTC day; `budgetNotice()` is true once that day, for the one line a caller posts.

import type { ModelPort } from '../ports/model.ts';

export interface RateWindow {
  max: number;
  windowMs: number;
}

export interface ChatLimitWindows {
  /** Model passes on chat messages one person starts. */
  perUser: RateWindow;
  /** Model passes on one incident's thread. */
  perIncident: RateWindow;
  /** New incidents one person starts from chat. */
  newIncidents: RateWindow;
}

export const CHAT_LIMITS: Readonly<ChatLimitWindows> = {
  perUser: { max: 30, windowMs: 10 * 60_000 },
  perIncident: { max: 60, windowMs: 10 * 60_000 },
  newIncidents: { max: 20, windowMs: 60 * 60_000 },
};

/** The one line a person is told on the day the budget runs out. */
export const BUDGET_SPENT_TEXT = "Snapwing has used today's model budget, so it is not taking new reports until tomorrow (UTC).";

/** Why a gate said no. */
export type ChatLimitRefusal = 'user' | 'incident' | 'budget';

export interface ChatLimits {
  /** One model pass on `user`'s message in `incident`'s thread; takes a slot when allowed. */
  modelWork(user: string, incident: string): ChatLimitRefusal | undefined;
  /** A new incident `user` starts from chat; takes a slot when allowed. */
  newIncident(user: string): ChatLimitRefusal | undefined;
  /** Counts one model call against today's budget. */
  countCall(): void;
  overBudget(): boolean;
  /** True the first time it is asked on a day the budget is spent, false after that until the next one. */
  budgetNotice(): boolean;
}

export interface ChatLimitsOptions {
  /** The playbook's daily model-call budget, read per call so a reload applies. */
  budget: () => number;
  clock: () => Date;
  windows?: Partial<ChatLimitWindows>;
  /** Called once per day when the count reaches the budget. */
  onSpent?: (budget: number) => void;
}

/** Keys remembered per window before the oldest is dropped. */
const MAX_KEYS = 10_000;

export function createChatLimits(options: ChatLimitsOptions): ChatLimits {
  const windows: ChatLimitWindows = { ...CHAT_LIMITS, ...options.windows };
  const hits = new Map<string, number[]>();
  let day = '';
  let calls = 0;
  let noticed = false;
  let spentTold = false;

  const today = (): string => options.clock().toISOString().slice(0, 10);
  function roll(): void {
    const d = today();
    if (d === day) return;
    day = d;
    calls = 0;
    noticed = false;
    spentTold = false;
  }
  const overBudget = (): boolean => {
    roll();
    return calls >= options.budget();
  };

  /** The key's hits still inside `window`. */
  function recent(key: string, window: RateWindow, now: number): number[] {
    const kept = (hits.get(key) ?? []).filter((t) => now - t < window.windowMs);
    hits.delete(key);
    if (kept.length > 0) hits.set(key, kept);
    return kept;
  }
  function take(key: string, now: number): void {
    const list = hits.get(key) ?? [];
    list.push(now);
    hits.set(key, list);
    if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value as string);
  }

  return {
    modelWork(user, incident) {
      if (overBudget()) return 'budget';
      const now = options.clock().getTime();
      if (recent(`u:${user}`, windows.perUser, now).length >= windows.perUser.max) return 'user';
      if (recent(`i:${incident}`, windows.perIncident, now).length >= windows.perIncident.max) return 'incident';
      take(`u:${user}`, now);
      take(`i:${incident}`, now);
      return undefined;
    },
    newIncident(user) {
      if (overBudget()) return 'budget';
      const now = options.clock().getTime();
      if (recent(`n:${user}`, windows.newIncidents, now).length >= windows.newIncidents.max) return 'user';
      take(`n:${user}`, now);
      return undefined;
    },
    countCall() {
      roll();
      calls += 1;
      const budget = options.budget();
      if (calls >= budget && !spentTold) {
        spentTold = true;
        options.onSpent?.(budget);
      }
    },
    overBudget,
    budgetNotice() {
      if (!overBudget() || noticed) return false;
      noticed = true;
      return true;
    },
  };
}

/** The model port with every call counted first (the daily budget's count). */
export function countModelCalls(model: ModelPort, count: () => void): ModelPort {
  return {
    complete(request) {
      count();
      return model.complete(request);
    },
    vision(request) {
      count();
      return model.vision(request);
    },
    classify(request) {
      count();
      return model.classify(request);
    },
  };
}
