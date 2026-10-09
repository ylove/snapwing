// Write and edit workspace-context.xml (main 4.2, 4.3 Confirm and Validate and deploy, 20.3, 22.3).
//
// `writeWorkspaceMap` serializes a typed map. `editWorkspaceMap` applies typed edits to an existing
// document in place with slimdom, so comments, whitespace, and attribute order survive. Both run the
// XSD and then the Schematron before returning, and an invalid result carries the typed errors and
// no XML: nothing invalid is ever handed back for a caller to deploy.

import { parseXmlDocument, serializeToWellFormedString, type Document, type Element, type Node } from 'slimdom';
import { validate, type ValidationError } from '../schemas/validate.ts';
import { WORKSPACE_SCHEMAS } from './parse.ts';
import type { AutonomyLevelId, MapChannel, MapOwnership, MapPerson, MapSurface, MapTerm, WorkspaceMap } from './types.ts';

export const WORKSPACE_NAMESPACE = 'urn:snapwing:workspace:v1';

export type MapWriteResult = { ok: true; xml: string } | { ok: false; errors: ValidationError[] };

/** A typed edit to an existing map document. Each names its target by id or handle. */
export type MapEdit =
  /** Set a surface's autonomy level, recording who changed it and when (main 4.6). Adds the override when absent. */
  | { kind: 'setSurfaceLevel'; surface: string; level: AutonomyLevelId; changedBy: string; changedAt: string }
  /**
   * Add or change a trigger emoji. Without `channel` it is a workspace `<emoji slack teams>` row keyed by its Slack
   * name; with `channel` it is that channel's `<trigger emoji>` override. `replaces` names the existing emoji to
   * change (default: `emoji` itself). `teams` defaults to `emoji` on a new workspace row.
   */
  | { kind: 'setTriggerEmoji'; emoji: string; teams?: string; minReactors?: number; replaces?: string; channel?: string }
  | { kind: 'addSurface'; surface: MapSurface }
  | { kind: 'addChannel'; channel: MapChannel }
  | { kind: 'addTerm'; term: MapTerm }
  | { kind: 'addPerson'; person: MapPerson }
  /** Replace a person's `owns` rows. */
  | { kind: 'setPersonOwnership'; handle: string; owns: MapOwnership[] }
  /** Set a person's chat ids; a string sets, `null` removes, absent leaves alone. */
  | { kind: 'setPersonChatIds'; handle: string; slackId?: string | null; teamsId?: string | null };

export interface EditOptions {
  /** When set, becomes the root's `updated` attribute (ISO 8601). */
  updated?: string;
}

async function checked(xml: string): Promise<MapWriteResult> {
  const result = await validate(xml, WORKSPACE_SCHEMAS);
  return result.valid ? { ok: true, xml } : { ok: false, errors: result.errors };
}

// Serialization

type Attrs = ReadonlyArray<readonly [string, string | number | boolean | undefined]>;

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
const escapeText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function open(name: string, attrs: Attrs): string {
  const parts = attrs.filter((a): a is readonly [string, string | number | boolean] => a[1] !== undefined).map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`);
  return `${name}${parts.join('')}`;
}

/** Serialize a map to XML and validate it. A map that parsed from a valid document always writes back valid. */
export async function writeWorkspaceMap(map: WorkspaceMap): Promise<MapWriteResult> {
  return checked(serialize(map));
}

function serialize(map: WorkspaceMap): string {
  const out: string[] = [];
  const line = (depth: number, text: string): void => {
    out.push(`${'  '.repeat(depth)}${text}`);
  };
  const leaf = (depth: number, name: string, attrs: Attrs): void => line(depth, `<${open(name, attrs)} />`);

  line(0, '<?xml version="1.0" encoding="UTF-8"?>');
  line(0, `<${open('workspace', [['xmlns', WORKSPACE_NAMESPACE], ['org', map.org], ['updated', map.updated]])}>`);

  line(1, `<${open('surfaces', [['fallbackSurface', map.fallbackSurface]])}>`);
  for (const s of map.surfaces) {
    line(2, `<${open('surface', [['id', s.id], ['label', s.label]])}>`);
    line(3, `<${open('repo', [['base', s.repoBase]])}>${escapeText(s.repo)}</repo>`);
    leaf(3, 'jira', [['project', s.jira.project], ['defaultIssueType', s.jira.defaultIssueType]]);
    if (s.components.length > 0) {
      line(3, '<components>');
      for (const c of s.components) leaf(4, 'component', [['id', c.id], ['label', c.label]]);
      line(3, '</components>');
    }
    line(2, '</surface>');
  }
  line(1, '</surfaces>');

  line(1, '<channels>');
  for (const c of map.channels) {
    const attrs: Attrs = [['id', c.id], ['name', c.name], ['surface', c.surface], ['confidence', c.confidence], ['platform', c.platform], ['team', c.teamId]];
    if (c.triggerEmoji.length === 0) leaf(2, 'channel', attrs);
    else {
      line(2, `<${open('channel', attrs)}>`);
      for (const e of c.triggerEmoji) leaf(3, 'trigger', [['emoji', e]]);
      line(2, '</channel>');
    }
  }
  line(1, '</channels>');

  line(1, '<triggers>');
  for (const m of map.triggers.messageActions) leaf(2, 'messageAction', [['label', m.label]]);
  for (const e of map.triggers.emoji) leaf(2, 'emoji', [['slack', e.slack], ['teams', e.teams], ['minReactors', e.minReactors]]);
  if (map.triggers.directMessage) leaf(2, 'directMessage', [['images', map.triggers.directMessage.images], ['text', map.triggers.directMessage.text]]);
  if (map.triggers.cli) leaf(2, 'cli', [['enabled', map.triggers.cli.enabled]]);
  line(1, '</triggers>');

  line(1, '<vocabulary>');
  for (const t of map.vocabulary) line(2, `<${open('term', [['surface', t.surface], ['component', t.component]])}>${escapeText(t.text)}</term>`);
  line(1, '</vocabulary>');

  line(1, '<people>');
  for (const p of map.people) {
    const attrs: Attrs = [['slackId', p.slackId], ['teamsId', p.teamsId], ['handle', p.handle], ['email', p.email], ['role', p.role]];
    if (p.owns.length === 0) leaf(2, 'person', attrs);
    else {
      line(2, `<${open('person', attrs)}>`);
      for (const o of p.owns) leaf(3, 'owns', [['surface', o.surface], ['component', o.component], ['primary', o.primary ? true : undefined]]);
      line(2, '</person>');
    }
  }
  line(1, '</people>');

  const { policies } = map;
  line(1, '<policies>');
  if (policies.askBack) {
    leaf(2, 'askBack', [
      ['maxQuestionsPerIncident', policies.askBack.maxQuestionsPerIncident],
      ['suppressWhenReportersAtLeast', policies.askBack.suppressWhenReportersAtLeast],
    ]);
  }
  const a = policies.autonomy;
  line(2, `<${open('autonomy', [['default', a.default], ['changedBy', a.changedBy], ['changedAt', a.changedAt]])}>`);
  for (const l of a.levels) {
    leaf(3, 'level', [['id', l.id], ['name', l.name], ['fixer', l.fixer], ['merge', l.merge], ['requires', l.requires.length > 0 ? l.requires.join(' ') : undefined]]);
  }
  if (a.overrides.length > 0) {
    line(3, '<overrides>');
    const order = { surface: 0, component: 1, priority: 2 } as const;
    for (const o of [...a.overrides].sort((x, y) => order[x.kind] - order[y.kind])) {
      const change: Attrs = [['changedBy', o.changedBy], ['changedAt', o.changedAt]];
      if (o.kind === 'surface') leaf(4, 'surface', [['ref', o.ref], ['level', o.level], ...change]);
      else if (o.kind === 'component') leaf(4, 'component', [['surface', o.surface], ['ref', o.ref], ['level', o.level], ...change]);
      else leaf(4, 'priority', [['atLeast', o.atLeast], ['level', o.level], ...change]);
    }
    line(3, '</overrides>');
  }
  line(2, '</autonomy>');
  if (policies.riskGate) {
    const r = policies.riskGate;
    const attrs: Attrs = [['maxFilesTouched', r.maxFilesTouched], ['maxDiffLines', r.maxDiffLines]];
    if (r.forbiddenPaths.length === 0) leaf(2, 'riskGate', attrs);
    else {
      line(2, `<${open('riskGate', attrs)}>`);
      for (const p of r.forbiddenPaths) line(3, `<forbiddenPath>${escapeText(p)}</forbiddenPath>`);
      line(2, '</riskGate>');
    }
  }
  line(1, '</policies>');
  line(0, '</workspace>');
  return `${out.join('\n')}\n`;
}

// Editing in place

class EditError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.rule = rule;
  }
}

/**
 * Apply `edits` in order to the document `xml` and validate the result. The first edit that cannot find its
 * target, a document that is not well formed, and any XSD or Schematron failure come back as `{ ok: false, errors }`.
 */
export async function editWorkspaceMap(xml: string, edits: readonly MapEdit[], options: EditOptions = {}): Promise<MapWriteResult> {
  let doc: Document;
  try {
    doc = parseXmlDocument(xml);
  } catch (err) {
    return { ok: false, errors: [{ message: `Workspace map is not well-formed XML: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  try {
    const root = doc.documentElement;
    if (root === null || root.localName !== 'workspace' || root.namespaceURI !== WORKSPACE_NAMESPACE) {
      throw new EditError('edit-not-a-map', 'The document is not a workspace map.');
    }
    for (const edit of edits) apply(doc, root, edit);
    if (options.updated !== undefined) root.setAttribute('updated', options.updated);
  } catch (err) {
    if (err instanceof EditError) return { ok: false, errors: [{ message: err.message, rule: err.rule }] };
    throw err;
  }
  const declaration = /^\s*<\?xml[^?]*\?>/.exec(xml)?.[0];
  const body = serializeToWellFormedString(doc);
  return checked(declaration === undefined ? body : `${declaration.trimStart()}\n${body}`);
}

function apply(doc: Document, root: Element, edit: MapEdit): void {
  switch (edit.kind) {
    case 'setSurfaceLevel': {
      const autonomy = need(path(root, 'policies', 'autonomy'), 'autonomy policy');
      let overrides = child(autonomy, 'overrides');
      if (overrides === null) {
        overrides = make(doc, 'overrides', []);
        insertAfter(autonomy, overrides, children(autonomy, 'level').at(-1) ?? null);
      }
      const existing = children(overrides, 'surface').find((s) => s.getAttribute('ref') === edit.surface);
      const target = existing ?? appendChild(overrides, make(doc, 'surface', [['ref', edit.surface]]));
      target.setAttribute('level', String(edit.level));
      target.setAttribute('changedBy', edit.changedBy);
      target.setAttribute('changedAt', edit.changedAt);
      return;
    }
    case 'setTriggerEmoji': {
      const from = edit.replaces ?? edit.emoji;
      if (edit.channel === undefined) {
        const triggers = need(child(root, 'triggers'), 'triggers');
        const rows = children(triggers, 'emoji');
        const found = rows.find((e) => e.getAttribute('slack') === from);
        const target = found ?? insertAfter(triggers, make(doc, 'emoji', [['slack', edit.emoji], ['teams', edit.teams ?? edit.emoji]]), rows.at(-1) ?? null);
        target.setAttribute('slack', edit.emoji);
        if (edit.teams !== undefined) target.setAttribute('teams', edit.teams);
        if (edit.minReactors !== undefined) target.setAttribute('minReactors', String(edit.minReactors));
        return;
      }
      const channel = need(
        children(need(child(root, 'channels'), 'channels'), 'channel').find((c) => c.getAttribute('id') === edit.channel),
        `channel ${edit.channel}`,
      );
      const found = children(channel, 'trigger').find((t) => t.getAttribute('emoji') === from);
      (found ?? appendChild(channel, make(doc, 'trigger', []))).setAttribute('emoji', edit.emoji);
      return;
    }
    case 'addSurface': {
      const s = edit.surface;
      const el = make(doc, 'surface', [['id', s.id], ['label', s.label]]);
      appendChild(el, make(doc, 'repo', [['base', s.repoBase]])).appendChild(doc.createTextNode(s.repo));
      appendChild(el, make(doc, 'jira', [['project', s.jira.project], ['defaultIssueType', s.jira.defaultIssueType]]));
      if (s.components.length > 0) {
        const components = appendChild(el, make(doc, 'components', []));
        for (const c of s.components) appendChild(components, make(doc, 'component', [['id', c.id], ['label', c.label]]));
      }
      appendChild(need(child(root, 'surfaces'), 'surfaces'), el);
      return;
    }
    case 'addChannel': {
      const c = edit.channel;
      const el = make(doc, 'channel', [['id', c.id], ['name', c.name], ['surface', c.surface], ['confidence', c.confidence], ['platform', c.platform], ['team', c.teamId]]);
      for (const e of c.triggerEmoji) appendChild(el, make(doc, 'trigger', [['emoji', e]]));
      appendChild(need(child(root, 'channels'), 'channels'), el);
      return;
    }
    case 'addTerm': {
      const t = edit.term;
      const el = make(doc, 'term', [['surface', t.surface], ['component', t.component]]);
      el.appendChild(doc.createTextNode(t.text));
      appendChild(need(child(root, 'vocabulary'), 'vocabulary'), el);
      return;
    }
    case 'addPerson': {
      const p = edit.person;
      const el = make(doc, 'person', [['slackId', p.slackId], ['teamsId', p.teamsId], ['handle', p.handle], ['email', p.email], ['role', p.role]]);
      for (const o of p.owns) appendChild(el, ownsElement(doc, o));
      appendChild(need(child(root, 'people'), 'people'), el);
      return;
    }
    case 'setPersonOwnership': {
      const person = findPerson(root, edit.handle);
      for (const o of children(person, 'owns')) removeWithIndent(o);
      for (const o of edit.owns) appendChild(person, ownsElement(doc, o));
      return;
    }
    case 'setPersonChatIds': {
      const person = findPerson(root, edit.handle);
      for (const [name, value] of [['slackId', edit.slackId], ['teamsId', edit.teamsId]] as const) {
        if (value === undefined) continue;
        if (value === null) person.removeAttribute(name);
        else person.setAttribute(name, value);
      }
      return;
    }
  }
}

function ownsElement(doc: Document, o: MapOwnership): Element {
  return make(doc, 'owns', [['surface', o.surface], ['component', o.component], ['primary', o.primary ? 'true' : undefined]]);
}

function findPerson(root: Element, handle: string): Element {
  return need(
    children(need(child(root, 'people'), 'people'), 'person').find((p) => p.getAttribute('handle') === handle),
    `person ${handle}`,
  );
}

// DOM helpers

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new EditError('edit-target-missing', `The map has no ${what} to edit.`);
  return value;
}

function isElement(n: Node): n is Element {
  return n.nodeType === 1;
}

function elementChildren(parent: Element): Element[] {
  return parent.childNodes.filter(isElement);
}

function children(parent: Element, name: string): Element[] {
  return elementChildren(parent).filter((e) => e.localName === name && e.namespaceURI === WORKSPACE_NAMESPACE);
}

function child(parent: Element, name: string): Element | null {
  return children(parent, name)[0] ?? null;
}

function path(from: Element, ...names: string[]): Element | null {
  let cur: Element | null = from;
  for (const n of names) {
    if (cur === null) return null;
    cur = child(cur, n);
  }
  return cur;
}

function make(doc: Document, name: string, attrs: ReadonlyArray<readonly [string, string | undefined]>): Element {
  const el = doc.createElementNS(WORKSPACE_NAMESPACE, name);
  for (const [k, v] of attrs) if (v !== undefined) el.setAttribute(k, v);
  return el;
}

const isBlank = (n: Node | null): boolean => n !== null && n.nodeType === 3 && (n.nodeValue ?? '').trim() === '';

/** The whitespace after the last newline in the text node before `el`, or '' when it is not on its own line. */
function indentOf(el: Element): string {
  const prev = el.previousSibling;
  if (prev === null || !isBlank(prev)) return '';
  const ws = prev.nodeValue ?? '';
  const nl = ws.lastIndexOf('\n');
  return nl === -1 ? '' : ws.slice(nl + 1);
}

function docOf(el: Element): Document {
  if (el.ownerDocument === null) throw new EditError('edit-detached', 'The element is not part of a document.');
  return el.ownerDocument;
}

/** Append `el` as the last child of `parent` on its own line, matching sibling indentation. */
function appendChild(parent: Element, el: Element): Element {
  const doc = docOf(parent);
  const last = parent.lastChild;
  const closing = last !== null && isBlank(last) ? last : null;
  const firstEl = elementChildren(parent)[0];
  const parentIndent = indentOf(parent);
  const childIndent = (firstEl === undefined ? '' : indentOf(firstEl)) || `${parentIndent}  `;
  const sep = doc.createTextNode(`\n${childIndent}`);
  if (closing !== null) {
    parent.insertBefore(sep, closing);
    parent.insertBefore(el, closing);
    if (!(closing.nodeValue ?? '').includes('\n')) closing.nodeValue = `\n${parentIndent}`;
  } else {
    parent.appendChild(sep);
    parent.appendChild(el);
    parent.appendChild(doc.createTextNode(`\n${parentIndent}`));
  }
  return el;
}

/** Insert `el` on its own line after `ref` (or as the first child when `ref` is null), matching indentation. */
function insertAfter(parent: Element, el: Element, ref: Element | null): Element {
  const first = elementChildren(parent)[0];
  if (ref === null) {
    if (first === undefined) return appendChild(parent, el);
    const sep = docOf(parent).createTextNode(`\n${indentOf(first)}`);
    parent.insertBefore(sep, first);
    parent.insertBefore(el, sep);
    return el;
  }
  // Keep a trailing same-line comment with `ref`: skip inline whitespace and comments up to the next line break.
  let anchor: Node = ref;
  for (let n = ref.nextSibling; n !== null; n = n.nextSibling) {
    if (n.nodeType === 8 || (isBlank(n) && !(n.nodeValue ?? '').includes('\n'))) anchor = n;
    else break;
  }
  const sep = docOf(parent).createTextNode(`\n${indentOf(ref)}`);
  const before = anchor.nextSibling;
  parent.insertBefore(sep, before);
  parent.insertBefore(el, before);
  return el;
}

/** Remove `el` and the line break that introduced it. */
function removeWithIndent(el: Element): void {
  const parent = el.parentNode;
  if (parent === null) return;
  const prev = el.previousSibling;
  if (prev !== null && isBlank(prev)) parent.removeChild(prev);
  parent.removeChild(el);
}
