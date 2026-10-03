import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultPlaybook, loadPlaybook, PLAYBOOK_XSD, PLAYBOOK_XSD_RULE, type Playbook, type PlaybookError } from '../../src/config/playbook.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { validateXsd } from '../../src/schemas/validate.ts';
import { parseDuration } from '../../src/util/duration.ts';

const root = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const example = readFileSync(root('examples/playbook.example.xml'), 'utf8');

const NS = 'urn:snapwing:playbook:v1';
const wrap = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<playbook xmlns="${NS}">\n${body}\n</playbook>`;

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(readFileSync(root('examples/workspace-context.example.xml'), 'utf8'));
});

async function load(xml: string): Promise<Playbook> {
  const result = await loadPlaybook(xml, map);
  if (!result.ok) throw new Error(`expected a playbook, got ${JSON.stringify(result.errors)}`);
  return result.playbook;
}

async function errorsOf(xml: string): Promise<PlaybookError[]> {
  const result = await loadPlaybook(xml, map);
  if (result.ok) throw new Error('expected errors, got a playbook');
  expect(result).not.toHaveProperty('playbook');
  return result.errors;
}

describe('defaults', () => {
  it('an empty <playbook/> is valid and loads to every Companion A default', async () => {
    const playbook = await load(`<playbook xmlns="${NS}"/>`);
    expect(playbook).toEqual(defaultPlaybook());
    expect(playbook.weights).toEqual({ reporter: 1, engineer: 1.5, owner: 2, window: 'PT2H' });
    expect(playbook.claims).toEqual({ expiry: 'PT4H', holdExpiry: 'PT2H', midFlightGrace: 'PT10M', businessHoursOnly: true });
    expect(playbook.monitor).toEqual({ interval: 'PT60S', heartbeat: 'PT10M', stallAfter: 'PT15M', critical: [] });
    expect(playbook.notifications.rateLimit).toEqual({ perIncident: 'PT5M' });
    expect(playbook.notifications.quietHours).toBeUndefined();
    expect(playbook.userSide).toEqual({ check: true, uxFrictionThreshold: 3, uxFrictionWindow: 'P30D' });
    expect(playbook.recordings).toEqual({ maxDuration: 'PT3M', sampleFps: 1 });
    expect(playbook.signals.lexicon).toEqual({ maxWords: 12, confidenceFloor: 0.7 });
    expect(playbook.signals.intents.claim.phrases).toContain('on it');
    expect(playbook.signals.reactionsAsButtons).toBe(false);
    expect(playbook.ladders[0]?.intents).toEqual(['trigger', 'escalate']);
    expect(playbook.ladders[0]?.steps.map((s) => s.score)).toEqual([3, 5, 8]);
  });

  it('a bare <playbook> with no namespace-declared children and a version loads too', async () => {
    expect(await load(`<playbook xmlns="${NS}" version="1"></playbook>`)).toEqual(defaultPlaybook());
  });

  it('loads defaults that do not share state between calls', async () => {
    const first = await load(`<playbook xmlns="${NS}"/>`);
    first.claims.expiry = 'PT1H';
    first.signals.intents.claim.phrases.push('mutated');
    expect((await load(`<playbook xmlns="${NS}"/>`)).claims.expiry).toBe('PT4H');
    expect(defaultPlaybook().signals.intents.claim.phrases).not.toContain('mutated');
  });

  it('a partial element keeps the other defaults', async () => {
    const playbook = await load(wrap('<weights owner="3"/><claims expiry="PT1H"/><monitor stallAfter="PT20M"/>'));
    expect(playbook.claims).toEqual({ expiry: 'PT1H', holdExpiry: 'PT2H', midFlightGrace: 'PT10M', businessHoursOnly: true });
    expect(playbook.weights).toEqual({ reporter: 1, engineer: 1.5, owner: 3, window: 'PT2H' });
    expect(playbook.monitor).toEqual({ interval: 'PT60S', heartbeat: 'PT10M', stallAfter: 'PT20M', critical: [] });
  });

  it('an intent replaces emoji and phrases independently', async () => {
    const playbook = await load(
      wrap('<signals><intent name="claim"><phrase>peeking</phrase></intent><intent name="stop"><emoji slack="x" teams="y"/></intent></signals>'),
    );
    expect(playbook.signals.intents.claim.phrases).toEqual(['peeking']);
    expect(playbook.signals.intents.claim.emoji).toEqual(defaultPlaybook().signals.intents.claim.emoji);
    expect(playbook.signals.intents.stop.emoji).toEqual([{ slack: 'x', teams: 'y' }]);
    expect(playbook.signals.intents.stop.phrases).toEqual(defaultPlaybook().signals.intents.stop.phrases);
  });

  it('a ladder replaces the default for its intents and leaves the others', async () => {
    const playbook = await load(wrap('<ladder intent="trigger"><step score="2" priority="+2"/></ladder>'));
    expect(playbook.ladders).toEqual([
      { intents: ['escalate'], steps: defaultPlaybook().ladders[0]?.steps },
      defaultPlaybook().ladders[1],
      {
        intents: ['trigger'],
        steps: [{ score: 2, priority: { raise: 2 }, note: false, mentionOwner: false, suppressAskBack: false, outage: false }],
      },
    ]);
  });
});

describe('full example', () => {
  it('validates against the XSD and loads against the example map', async () => {
    expect(await validateXsd(example, PLAYBOOK_XSD)).toEqual({ valid: true, errors: [] });
    const playbook = await load(example);

    expect(playbook.version).toBe(1);
    expect(playbook.signals.intents.trigger.emoji).toEqual([
      { slack: 'bug', teams: 'bug' },
      { slack: 'ladybug', teams: 'ladybug', channel: 'app-bugs' },
    ]);
    expect(playbook.signals.intents.claim.phrases).toEqual(['on it', 'peeking']);
    expect(playbook.signals.intents.accept.emoji[0]).toEqual({ slack: '+1', teams: 'like' });
    // Intents the file does not mention keep their defaults.
    expect(playbook.signals.intents.reject).toEqual(defaultPlaybook().signals.intents.reject);

    expect(playbook.ladders.find((l) => l.intents.includes('trigger'))?.steps).toEqual([
      { score: 3, priority: { raise: 1 }, note: true, mentionOwner: false, suppressAskBack: false, outage: false },
      { score: 5, priority: { set: 'Highest' }, note: false, mentionOwner: true, suppressAskBack: true, outage: false },
      { score: 8, note: false, mentionOwner: false, suppressAskBack: false, outage: true },
    ]);

    expect(playbook.notifications.quietHours).toEqual({ tz: 'America/New_York', from: '20:00', to: '08:00', exceptPriority: 'Highest' });
    expect(playbook.notifications.forcePush).toEqual([{ priority: 'Highest' }, { surface: 'web' }]);
    expect(playbook.notifications.digests).toEqual([{ to: '#eng-leads', cron: '0 9 * * 1-5' }]);
    expect(playbook.monitor.critical).toEqual(['web', 'admin']);

    expect(playbook.escalations.map((e) => e.name)).toEqual(['outage', 'stalled-fix']);
    expect(playbook.escalations[0]?.steps).toEqual([
      { duration: 'PT0M', mention: 'owner' },
      { duration: 'PT30M', mention: '@U0WEBDEV1' },
      { duration: 'PT60M', pagerduty: 'P123ABC' },
      { duration: 'PT2H', mention: '@U0MOBDEV', channel: '#incidents' },
    ]);
    expect(playbook.escalations[0]?.applyWhen).toEqual([{ priority: 'Highest' }, { outage: true }]);
    expect(playbook.escalations[1]?.applyWhen).toEqual([{ monitored: true, stalled: true }]);
    expect(playbook.userSide).toEqual({ check: true, uxFrictionThreshold: 3, uxFrictionWindow: 'P30D' });
  });
});

describe('Schematron rules', () => {
  const rules = (errors: PlaybookError[]): string[] => errors.map((e) => e.rule);

  it('rejects a mention of a person who is not in the map, naming the rule', async () => {
    const errors = await errorsOf(wrap('<escalation name="e"><after duration="PT1M" mention="@U0NOBODY"/></escalation>'));
    expect(rules(errors)).toEqual(['mention-resolves']);
    expect(errors[0]?.message).toContain('@U0NOBODY');
    expect(errors[0]?.line).toBe(3);
  });

  it('resolves mentions by Slack id, Teams id, or handle, and "owner"', async () => {
    const xml = wrap(
      '<escalation name="e"><after duration="PT1M" mention="owner"/><after duration="PT2M" mention="@U0MOBDEV"/><after duration="PT3M" mention="@webDev1"/></escalation>',
    );
    expect((await load(xml)).escalations[0]?.steps).toHaveLength(3);
  });

  it('rejects a bare mention without @', async () => {
    expect(rules(await errorsOf(wrap('<escalation name="e"><after duration="PT1M" mention="U0MOBDEV"/></escalation>')))).toEqual(['mention-resolves']);
  });

  it('rejects an undeclared surface in forcePush and in monitor', async () => {
    const errors = await errorsOf(wrap('<notifications><forcePush surface="nope"/></notifications><monitor><critical surface="ghost"/></monitor>'));
    expect(rules(errors)).toEqual(['force-push-surface-exists', 'critical-surface-exists']);
  });

  it('rejects an emoji limited to a channel that is not in the map', async () => {
    const errors = await errorsOf(wrap('<signals><intent name="trigger"><emoji slack="a" teams="b" channel="no-such"/></intent></signals>'));
    expect(rules(errors)).toEqual(['emoji-channel-exists']);
    const ok = await load(wrap('<signals><intent name="trigger"><emoji slack="a" teams="b" channel="#web-bugs"/></intent></signals>'));
    expect(ok.signals.intents.trigger.emoji[0]?.channel).toBe('#web-bugs');
  });

  it('rejects an escalation step shorter than its predecessor', async () => {
    const errors = await errorsOf(
      wrap('<escalation name="outage"><after duration="PT30M" mention="owner"/><after duration="PT10M" mention="owner"/></escalation>'),
    );
    expect(rules(errors)).toEqual(['escalation-step-order']);
    expect(errors[0]?.message).toContain('outage');
  });

  it('allows equal escalation steps, rejects a shorter one, and compares across units', async () => {
    const equal = await load(wrap('<escalation name="e"><after duration="PT0M" mention="owner"/><after duration="PT60M" mention="owner"/><after duration="PT1H" channel="#incidents"/></escalation>'));
    expect(equal.escalations[0]?.steps).toHaveLength(3);
    expect(
      rules(await errorsOf(wrap('<escalation name="e"><after duration="PT2H" mention="owner"/><after duration="PT90M" mention="owner"/></escalation>'))),
    ).toEqual(['escalation-step-order']);
    const ok = await load(wrap('<escalation name="e"><after duration="PT90M" mention="owner"/><after duration="PT2H" mention="owner"/><after duration="P1D" mention="owner"/></escalation>'));
    expect(ok.escalations[0]?.steps).toHaveLength(3);
  });

  it('checks each escalation on its own and reports every violation', async () => {
    const errors = await errorsOf(
      wrap(
        '<escalation name="a"><after duration="PT2H" mention="owner"/><after duration="PT1H" mention="owner"/></escalation>' +
          '<escalation name="b"><after duration="PT1H" mention="owner"/><after duration="PT30M" mention="owner"/></escalation>',
      ),
    );
    expect(rules(errors)).toEqual(['escalation-step-order', 'escalation-step-order']);
  });

  it('rejects a step with no action, an empty applyWhen, and a forcePush with both or neither', async () => {
    expect(rules(await errorsOf(wrap('<escalation name="e"><after duration="PT1M"/></escalation>')))).toEqual(['escalation-step-action']);
    expect(rules(await errorsOf(wrap('<escalation name="e"><after duration="PT1M" mention="owner"/><applyWhen/></escalation>')))).toEqual([
      'apply-when-condition',
    ]);
    expect(rules(await errorsOf(wrap('<notifications><forcePush/></notifications>')))).toEqual(['force-push-one-of']);
    expect(rules(await errorsOf(wrap('<notifications><forcePush priority="High" surface="web"/></notifications>')))).toEqual(['force-push-one-of']);
  });

  it('runs against the map it is given', async () => {
    const xml = wrap('<escalation name="e"><after duration="PT1M" mention="@U0NEWHIRE"/></escalation>');
    expect(rules(await errorsOf(xml))).toEqual(['mention-resolves']);
    const grown: WorkspaceMap = { ...map, people: [...map.people, { slackId: 'U0NEWHIRE', handle: 'newHire', role: 'engineer', owns: [] }] };
    const result = await loadPlaybook(xml, grown);
    expect(result.ok).toBe(true);
  });

  it('keeps playbook line numbers after the XML declaration is dropped', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<playbook xmlns="${NS}">\n\n<notifications>\n<forcePush surface="nope"/>\n</notifications>\n</playbook>`;
    expect((await errorsOf(xml))[0]?.line).toBe(5);
  });
});

describe('structural errors and durations', () => {
  it('returns an xsd error for malformed XML', async () => {
    const errors = await errorsOf('<playbook xmlns="urn:snapwing:playbook:v1">');
    expect(errors[0]?.rule).toBe(PLAYBOOK_XSD_RULE);
  });

  it('rejects the wrong namespace and unknown elements', async () => {
    expect((await errorsOf('<playbook/>'))[0]?.rule).toBe(PLAYBOOK_XSD_RULE);
    expect((await errorsOf(wrap('<nonsense/>')))[0]?.rule).toBe(PLAYBOOK_XSD_RULE);
  });

  it('accepts ISO 8601 durations in days, hours, minutes, and seconds', async () => {
    for (const d of ['PT30M', 'PT60S', 'PT1H30M', 'P1D', 'P30D', 'P1DT12H', 'PT0M', 'PT1.5S']) {
      expect(await load(wrap(`<claims expiry="${d}"/>`))).toMatchObject({ claims: { expiry: d } });
      expect(() => parseDuration(d)).not.toThrow();
    }
  });

  it('rejects anything else in a duration slot, naming the xsd rule', async () => {
    for (const d of ['30m', '30', 'PT', 'P', 'PT30', 'P1Y', 'P1M', 'P1W', 'PT-5M', '', 'two hours', '1H']) {
      const errors = await errorsOf(wrap(`<claims expiry="${d}"/>`));
      expect(errors.map((e) => e.rule), `duration ${JSON.stringify(d)}`).toEqual([PLAYBOOK_XSD_RULE]);
    }
    expect((await errorsOf(wrap('<escalation name="e"><after duration="soon" mention="owner"/></escalation>')))[0]?.rule).toBe(PLAYBOOK_XSD_RULE);
  });

  it('every duration the loader returns parses', async () => {
    const playbook = await load(example);
    const durations = [
      playbook.weights.window,
      playbook.claims.expiry,
      playbook.claims.holdExpiry,
      playbook.claims.midFlightGrace,
      playbook.notifications.rateLimit.perIncident,
      playbook.monitor.interval,
      playbook.monitor.heartbeat,
      playbook.monitor.stallAfter,
      playbook.userSide.uxFrictionWindow,
      playbook.recordings.maxDuration,
      ...playbook.escalations.flatMap((e) => e.steps.map((s) => s.duration)),
    ];
    for (const d of durations) expect(() => parseDuration(d)).not.toThrow();
  });

  it('rejects out-of-range values', async () => {
    for (const body of [
      '<lexicon maxWords="0"/>',
      '<lexicon confidenceFloor="1.5"/>',
      '<weights owner="-1"/>',
      '<userSide uxFrictionThreshold="0"/>',
      '<recordings sampleFps="0"/>',
      '<notifications><quietHours tz="UTC" from="25:00" to="08:00"/></notifications>',
      '<notifications><digest to="#x" cron="0 9 *"/></notifications>',
      '<ladder intent="claim"><step score="1"/></ladder>',
      '<ladder intent="trigger"><step score="1" priority="+9"/></ladder>',
    ]) {
      const wrapped = body.startsWith('<lexicon') ? `<signals>${body}</signals>` : body;
      expect((await errorsOf(wrap(wrapped)))[0]?.rule, body).toBe(PLAYBOOK_XSD_RULE);
    }
  });

  it('rejects duplicate intent and escalation names', async () => {
    expect((await errorsOf(wrap('<signals><intent name="claim"/><intent name="claim"/></signals>')))[0]?.rule).toBe(PLAYBOOK_XSD_RULE);
    const dup = '<escalation name="x"><after duration="PT1M" mention="owner"/></escalation>';
    expect((await errorsOf(wrap(dup + dup)))[0]?.rule).toBe(PLAYBOOK_XSD_RULE);
  });

  it('does not run the Schematron when the structure fails', async () => {
    const errors = await errorsOf(wrap('<escalation name="e"><after duration="soon" mention="@U0NOBODY"/></escalation>'));
    expect(errors.every((e) => e.rule === PLAYBOOK_XSD_RULE)).toBe(true);
  });
});
