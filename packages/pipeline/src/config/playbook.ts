// Playbook, playbook.xml (A 6.2). Schemas: schemas/playbook.xsd and schemas/playbook.sch.
// Every element has a default, so an empty <playbook/> loads; `loadPlaybook` always returns a
// complete Playbook or a list of typed errors, never a partial playbook.

import { parseXmlDocument, type Element } from 'slimdom';
import type { JiraPriorityName, WorkspaceMap } from '../map/types.ts';
import { validateSchematron, validateXsd, type ValidationError } from '../schemas/validate.ts';
import { assetPath } from '../util/assets.ts';

export const PLAYBOOK_NAMESPACE = 'urn:snapwing:playbook:v1';
/** Namespace of the wrapper document the Schematron runs on (see schemas/playbook.sch). */
export const PLAYBOOK_CHECK_NAMESPACE = 'urn:snapwing:playbook-check:v1';
export const PLAYBOOK_XSD = assetPath('schemas/playbook.xsd');
export const PLAYBOOK_SCH = assetPath('schemas/playbook.sch');

/** Rule name on an error that comes from the XSD (Schematron errors carry their assert id). */
export const PLAYBOOK_XSD_RULE = 'xsd';

export const PLAYBOOK_INTENTS = ['trigger', 'escalate', 'claim', 'release', 'stop', 'accept', 'reject', 'watch', 'not-a-bug'] as const;
export const LADDER_INTENTS = ['trigger', 'escalate', 'accept', 'reject'] as const;

export type PlaybookIntent = (typeof PLAYBOOK_INTENTS)[number];
export type LadderIntent = (typeof LADDER_INTENTS)[number];

export interface PlaybookEmoji {
  slack: string;
  teams: string;
  /** Limits the emoji to one channel (name or id). */
  channel?: string;
}

export interface IntentVocabulary {
  emoji: PlaybookEmoji[];
  phrases: string[];
}

export interface PlaybookSignals {
  intents: Record<PlaybookIntent, IntentVocabulary>;
  lexicon: { maxWords: number; confidenceFloor: number };
  reactionsAsButtons: boolean;
  reactionsAsApproval: boolean;
}

export interface PlaybookWeights {
  reporter: number;
  engineer: number;
  owner: number;
  /** ISO 8601 duration. */
  window: string;
}

export type PriorityChange = { raise: number } | { set: JiraPriorityName };

export interface LadderStep {
  score: number;
  priority?: PriorityChange;
  note: boolean;
  mentionOwner: boolean;
  suppressAskBack: boolean;
  outage: boolean;
}

export interface PlaybookLadder {
  intents: LadderIntent[];
  steps: LadderStep[];
}

export interface PlaybookClaims {
  expiry: string;
  holdExpiry: string;
  midFlightGrace: string;
  businessHoursOnly: boolean;
}

export interface QuietHours {
  tz: string;
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
  exceptPriority?: JiraPriorityName;
}

export type ForcePush = { priority: JiraPriorityName } | { surface: string };

export interface PlaybookDigest {
  to: string;
  cron: string;
}

export interface PlaybookNotifications {
  /** Absent: no quiet hours. */
  quietHours?: QuietHours;
  rateLimit: { perIncident: string };
  forcePush: ForcePush[];
  digests: PlaybookDigest[];
}

export interface PlaybookMonitor {
  interval: string;
  heartbeat: string;
  stallAfter: string;
  /** Surface ids marked critical. */
  critical: string[];
}

export interface EscalationStep {
  /** ISO 8601 duration; not shorter than the step before it (checked by the Schematron). */
  duration: string;
  /** `owner` or `@<person id>`. */
  mention?: string;
  pagerduty?: string;
  channel?: string;
}

export interface EscalationCondition {
  priority?: JiraPriorityName;
  outage?: boolean;
  monitored?: boolean;
  stalled?: boolean;
}

export interface PlaybookEscalation {
  name: string;
  steps: EscalationStep[];
  applyWhen: EscalationCondition[];
}

export interface PlaybookUserSide {
  check: boolean;
  uxFrictionThreshold: number;
  uxFrictionWindow: string;
}

export interface PlaybookRecordings {
  maxDuration: string;
  sampleFps: number;
}

/** Chat abuse limits (main 16, #272). */
export interface PlaybookLimits {
  /** Model calls per UTC day; once spent, chat starts no new model work until the next day. */
  modelCallsPerDay: number;
}

export interface Playbook {
  version: 1;
  signals: PlaybookSignals;
  weights: PlaybookWeights;
  ladders: PlaybookLadder[];
  claims: PlaybookClaims;
  notifications: PlaybookNotifications;
  monitor: PlaybookMonitor;
  /** No default ladders: empty unless the playbook declares some. */
  escalations: PlaybookEscalation[];
  userSide: PlaybookUserSide;
  recordings: PlaybookRecordings;
  limits: PlaybookLimits;
}

/** One reason a playbook was rejected. `rule` is `xsd` or the id of the Schematron assert that fired. */
export interface PlaybookError {
  rule: string;
  message: string;
  line?: number;
}

export type PlaybookResult = { ok: true; playbook: Playbook } | { ok: false; errors: PlaybookError[] };

// Defaults (A 1.1, 1.2, 1.4, 2.4, 4.4, 4.5, 5.3, 6.2). Emoji are reaction names per platform.

function emoji(slack: string, teams: string = slack): PlaybookEmoji {
  return { slack, teams };
}

/** A fresh copy of the playbook an empty `<playbook/>` loads to. */
export function defaultPlaybook(): Playbook {
  return {
    version: 1,
    signals: {
      intents: {
        trigger: { emoji: [emoji('bug')], phrases: ['snap it', 'file this', 'can someone fix this'] },
        escalate: {
          emoji: [emoji('fire'), emoji('rotating_light')],
          phrases: ['this is urgent', 'customers are hitting this', 'prod is down'],
        },
        claim: {
          emoji: [emoji('eyes'), emoji('raising_hand')],
          phrases: ['on it', 'looking', 'checking', 'I got it', 'mine', 'taking a look'],
        },
        release: {
          emoji: [emoji('no_good')],
          phrases: ['not it', "can't right now", 'someone else take this', 'handing off'],
        },
        stop: { emoji: [emoji('octagonal_sign'), emoji('raised_hand')], phrases: ['stop', 'hold off', "don't fix this yet", 'wait'] },
        accept: {
          emoji: [emoji('+1', 'like'), emoji('pray'), emoji('white_check_mark'), emoji('heart'), emoji('tada')],
          phrases: ['looks good', 'works now', 'confirmed', 'ship it'],
        },
        reject: { emoji: [emoji('-1', 'dislike'), emoji('x')], phrases: ['still broken', 'not fixed', 'nope'] },
        watch: { emoji: [emoji('bell'), emoji('eye')], phrases: ['keep me posted', 'let me know', 'ping me when'] },
        'not-a-bug': {
          emoji: [emoji('shrug')],
          phrases: ["that's expected", 'working as intended', 'user error on my end'],
        },
      },
      lexicon: { maxWords: 12, confidenceFloor: 0.7 },
      reactionsAsButtons: false,
      reactionsAsApproval: false,
    },
    weights: { reporter: 1, engineer: 1.5, owner: 2, window: 'PT2H' },
    ladders: [
      {
        intents: ['trigger', 'escalate'],
        steps: [
          { score: 3, priority: { raise: 1 }, note: true, mentionOwner: false, suppressAskBack: false, outage: false },
          { score: 5, priority: { set: 'Highest' }, note: false, mentionOwner: true, suppressAskBack: true, outage: false },
          { score: 8, note: false, mentionOwner: false, suppressAskBack: false, outage: true },
        ],
      },
      {
        intents: ['accept'],
        steps: [{ score: 3, note: true, mentionOwner: false, suppressAskBack: false, outage: false }],
      },
    ],
    claims: { expiry: 'PT4H', holdExpiry: 'PT2H', midFlightGrace: 'PT10M', businessHoursOnly: true },
    notifications: { rateLimit: { perIncident: 'PT5M' }, forcePush: [], digests: [] },
    monitor: { interval: 'PT60S', heartbeat: 'PT10M', stallAfter: 'PT15M', critical: [] },
    escalations: [],
    userSide: { check: true, uxFrictionThreshold: 3, uxFrictionWindow: 'P30D' },
    recordings: { maxDuration: 'PT3M', sampleFps: 1 },
    limits: { modelCallsPerDay: 5000 },
  };
}

/**
 * Validate `xml` against the playbook XSD, then (if the structure passes) the Schematron rules
 * with `map` supplying the people, surfaces, and channels that references must resolve to, and
 * convert it to a Playbook with every default filled in. Never throws: invalid input returns
 * every error found, each naming its rule.
 */
export async function loadPlaybook(xml: string, map: WorkspaceMap): Promise<PlaybookResult> {
  const structural = await validateXsd(xml, PLAYBOOK_XSD);
  if (!structural.valid) return rejected(structural.errors, PLAYBOOK_XSD_RULE);
  const references = await validateSchematron(wrapWithMap(xml, map), PLAYBOOK_SCH);
  if (!references.valid) return rejected(references.errors, 'schematron');
  try {
    return { ok: true, playbook: convert(xml) };
  } catch (err) {
    // The XSD passed, so this is a gap between schema and loader; still a typed error, not a throw.
    return { ok: false, errors: [{ rule: 'loader', message: err instanceof Error ? err.message : String(err) }] };
  }
}

/**
 * The playbook in a cached body (`config_versions`, kind `playbook`), converted without validation:
 * loaders validate before they cache. Synchronous because the append transaction reads it
 * (`projections/notify-context.ts`). `undefined` when the body does not convert.
 */
export function parseCachedPlaybook(xml: string): Playbook | undefined {
  try {
    return convert(xml);
  } catch {
    return undefined;
  }
}

function rejected(errors: readonly ValidationError[], fallbackRule: string): PlaybookResult {
  return {
    ok: false,
    errors: errors.map((e): PlaybookError => ({
      rule: e.rule ?? fallbackRule,
      message: e.message,
      ...(e.line === undefined ? {} : { line: e.line }),
    })),
  };
}

// Schematron input: the playbook plus a digest of the map. The XML declaration is dropped but its
// line break stays, so the playbook's line numbers are unchanged in error reports.

function wrapWithMap(xml: string, map: WorkspaceMap): string {
  const attr = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const surfaces = map.surfaces.map((s) => `<c:surface id="${attr(s.id)}"/>`);
  const people = map.people.flatMap((p) =>
    [p.slackId, p.teamsId, p.handle].filter((id): id is string => id !== undefined && id !== '').map((id) => `<c:person id="${attr(id)}"/>`),
  );
  const channels = map.channels.map((c) => `<c:channel id="${attr(c.id)}" name="${attr(c.name)}"/>`);
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const body = text.replace(/^\s*<\?xml[^?]*\?>/, '');
  return `<c:check xmlns:c="${PLAYBOOK_CHECK_NAMESPACE}">${body}<c:map>${[...surfaces, ...people, ...channels].join('')}</c:map></c:check>`;
}

// Conversion. The document already passed the XSD, so values are well formed; this only reads them.

function convert(xml: string): Playbook {
  const root = parseXmlDocument(xml).documentElement;
  if (!root) throw new Error('playbook has no root element');
  const defaults = defaultPlaybook();

  const signalsEl = child(root, 'signals');
  const signals = defaults.signals;
  if (signalsEl) {
    for (const el of children(signalsEl, 'intent')) {
      const name = el.getAttribute('name') as PlaybookIntent;
      // Emoji and phrases are replaced independently: an intent that lists only emoji keeps its phrases.
      const emojis = children(el, 'emoji').map((e): PlaybookEmoji => {
        const channel = e.getAttribute('channel');
        return { slack: attr(e, 'slack'), teams: attr(e, 'teams'), ...(channel === null ? {} : { channel: channel.trim() }) };
      });
      const phrases = children(el, 'phrase').map((p) => (p.textContent ?? '').trim());
      if (emojis.length > 0) signals.intents[name].emoji = emojis;
      if (phrases.length > 0) signals.intents[name].phrases = phrases;
    }
    const lexicon = child(signalsEl, 'lexicon');
    if (lexicon) {
      signals.lexicon.maxWords = num(lexicon, 'maxWords', signals.lexicon.maxWords);
      signals.lexicon.confidenceFloor = num(lexicon, 'confidenceFloor', signals.lexicon.confidenceFloor);
    }
    signals.reactionsAsButtons = toggle(child(signalsEl, 'reactionsAsButtons'), signals.reactionsAsButtons);
    signals.reactionsAsApproval = toggle(child(signalsEl, 'reactionsAsApproval'), signals.reactionsAsApproval);
  }

  const weightsEl = child(root, 'weights');
  const weights = defaults.weights;
  if (weightsEl) {
    weights.reporter = num(weightsEl, 'reporter', weights.reporter);
    weights.engineer = num(weightsEl, 'engineer', weights.engineer);
    weights.owner = num(weightsEl, 'owner', weights.owner);
    weights.window = str(weightsEl, 'window', weights.window);
  }

  // A <ladder> replaces the default ladder for exactly the intents it names; other defaults stay.
  const declared = children(root, 'ladder').map((el): PlaybookLadder => ({
    intents: attr(el, 'intent').split(/\s+/).filter((i) => i !== '') as LadderIntent[],
    steps: children(el, 'step').map(ladderStep),
  }));
  const overridden = new Set(declared.flatMap((l) => l.intents));
  const ladders = [
    ...defaults.ladders.flatMap((l): PlaybookLadder[] => {
      const intents = l.intents.filter((i) => !overridden.has(i));
      return intents.length === 0 ? [] : [{ intents, steps: l.steps }];
    }),
    ...declared,
  ];

  const claimsEl = child(root, 'claims');
  const claims = defaults.claims;
  if (claimsEl) {
    claims.expiry = str(claimsEl, 'expiry', claims.expiry);
    claims.holdExpiry = str(claimsEl, 'holdExpiry', claims.holdExpiry);
    claims.midFlightGrace = str(claimsEl, 'midFlightGrace', claims.midFlightGrace);
    claims.businessHoursOnly = bool(claimsEl, 'businessHoursOnly', claims.businessHoursOnly);
  }

  const notifications = defaults.notifications;
  const notificationsEl = child(root, 'notifications');
  if (notificationsEl) {
    const quiet = child(notificationsEl, 'quietHours');
    if (quiet) {
      const except = quiet.getAttribute('exceptPriority');
      notifications.quietHours = {
        tz: attr(quiet, 'tz'),
        from: attr(quiet, 'from'),
        to: attr(quiet, 'to'),
        ...(except === null ? {} : { exceptPriority: except.trim() as JiraPriorityName }),
      };
    }
    const rate = child(notificationsEl, 'rateLimit');
    if (rate) notifications.rateLimit = { perIncident: attr(rate, 'perIncident') };
    notifications.forcePush = children(notificationsEl, 'forcePush').map((el): ForcePush => {
      const priority = el.getAttribute('priority');
      return priority === null ? { surface: attr(el, 'surface') } : { priority: priority.trim() as JiraPriorityName };
    });
    notifications.digests = children(notificationsEl, 'digest').map((el) => ({ to: attr(el, 'to'), cron: attr(el, 'cron') }));
  }

  const monitorEl = child(root, 'monitor');
  const monitor = defaults.monitor;
  if (monitorEl) {
    monitor.interval = str(monitorEl, 'interval', monitor.interval);
    monitor.heartbeat = str(monitorEl, 'heartbeat', monitor.heartbeat);
    monitor.stallAfter = str(monitorEl, 'stallAfter', monitor.stallAfter);
    monitor.critical = children(monitorEl, 'critical').map((el) => attr(el, 'surface'));
  }

  const escalations = children(root, 'escalation').map((el): PlaybookEscalation => ({
    name: attr(el, 'name'),
    steps: children(el, 'after').map((a): EscalationStep => {
      const mention = a.getAttribute('mention');
      const pagerduty = a.getAttribute('pagerduty');
      const channel = a.getAttribute('channel');
      return {
        duration: attr(a, 'duration'),
        ...(mention === null ? {} : { mention: mention.trim() }),
        ...(pagerduty === null ? {} : { pagerduty: pagerduty.trim() }),
        ...(channel === null ? {} : { channel: channel.trim() }),
      };
    }),
    applyWhen: children(el, 'applyWhen').map((w): EscalationCondition => {
      const priority = w.getAttribute('priority');
      return {
        ...(priority === null ? {} : { priority: priority.trim() as JiraPriorityName }),
        ...optBool(w, 'outage'),
        ...optBool(w, 'monitored'),
        ...optBool(w, 'stalled'),
      };
    }),
  }));

  const userSideEl = child(root, 'userSide');
  const userSide = defaults.userSide;
  if (userSideEl) {
    userSide.check = bool(userSideEl, 'check', userSide.check);
    userSide.uxFrictionThreshold = num(userSideEl, 'uxFrictionThreshold', userSide.uxFrictionThreshold);
    userSide.uxFrictionWindow = str(userSideEl, 'uxFrictionWindow', userSide.uxFrictionWindow);
  }

  const recordingsEl = child(root, 'recordings');
  const recordings = defaults.recordings;
  if (recordingsEl) {
    recordings.maxDuration = str(recordingsEl, 'maxDuration', recordings.maxDuration);
    recordings.sampleFps = num(recordingsEl, 'sampleFps', recordings.sampleFps);
  }

  const limitsEl = child(root, 'limits');
  const limits = defaults.limits;
  if (limitsEl) limits.modelCallsPerDay = num(limitsEl, 'modelCallsPerDay', limits.modelCallsPerDay);

  return { version: 1, signals, weights, ladders, claims, notifications, monitor, escalations, userSide, recordings, limits };
}

function ladderStep(el: Element): LadderStep {
  const priority = el.getAttribute('priority')?.trim();
  const change: PriorityChange | undefined =
    priority === undefined ? undefined : priority.startsWith('+') ? { raise: Number(priority.slice(1)) } : { set: priority as JiraPriorityName };
  return {
    score: num(el, 'score', 0),
    ...(change === undefined ? {} : { priority: change }),
    note: bool(el, 'note', false),
    mentionOwner: bool(el, 'mentionOwner', false),
    suppressAskBack: bool(el, 'suppressAskBack', false),
    outage: bool(el, 'outage', false),
  };
}

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === name);
}

function child(parent: Element, name: string): Element | undefined {
  return children(parent, name)[0];
}

function attr(el: Element, name: string): string {
  const value = el.getAttribute(name);
  if (value === null) throw new Error(`<${el.localName}> is missing attribute ${name}`);
  return value.trim();
}

function str(el: Element, name: string, fallback: string): string {
  return el.getAttribute(name)?.trim() ?? fallback;
}

function num(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  return raw === null ? fallback : Number(raw.trim());
}

function parseBool(raw: string): boolean {
  const v = raw.trim();
  return v === 'true' || v === '1';
}

function bool(el: Element, name: string, fallback: boolean): boolean {
  const raw = el.getAttribute(name);
  return raw === null ? fallback : parseBool(raw);
}

function optBool(el: Element, name: string): Record<string, boolean> {
  const raw = el.getAttribute(name);
  return raw === null ? {} : { [name]: parseBool(raw) };
}

function toggle(el: Element | undefined, fallback: boolean): boolean {
  return el === undefined ? fallback : bool(el, 'enabled', fallback);
}
