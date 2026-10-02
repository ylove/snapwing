// Implementation request (main 9.2, Companion B 6.2): build, parse, and validate.
// Written by triage, read by the fixer and the review agent. Schema: schemas/implementation-request.xsd.
//
// Text content is whitespace-normalized (runs of whitespace collapse to one space, ends trimmed)
// on both build and parse, so build -> parse round-trips and the XML never depends on indentation.

import { fileURLToPath } from 'node:url';
import { parseXmlDocument, type Element } from 'slimdom';
import { validateXsd, type ValidationResult } from '../schemas/validate.ts';

export const IMPLEMENTATION_REQUEST_NAMESPACE = 'urn:snapwing:impl:v1';

/** Absolute path to the XSD, for callers that want to run `validate` themselves. */
export const IMPLEMENTATION_REQUEST_XSD = fileURLToPath(new URL('../../../../schemas/implementation-request.xsd', import.meta.url));

export type Confidence = 'low' | 'medium' | 'high';
export type HandoffMode = 'review' | 'auto';
export type AutonomyLevel = 0 | 1 | 2 | 3;

export interface ReportEvidence {
  kind: 'report';
  source: string;
  channel?: string;
  reporter?: string;
  ts?: string;
  text: string;
}
export interface ScreenshotEvidence {
  kind: 'screenshot';
  ref: string;
}
export interface AlertEvidence {
  kind: 'alert';
  /** True when the reporter's evidence includes no alert. */
  none?: boolean;
  source?: string;
  ref?: string;
  text?: string;
}
export type Evidence = ReportEvidence | ScreenshotEvidence | AlertEvidence;

export interface DiagnosisFile {
  path: string;
  note: string;
}
export interface Diagnosis {
  confidence: Confidence;
  by: string;
  files: DiagnosisFile[];
}

export interface Constraints {
  scope: string;
  tests: { required: boolean; text: string };
  forbidden: string[];
}

export interface Handoff {
  mode: HandoffMode;
  autonomy: AutonomyLevel;
  branch?: string;
  base?: string;
  allOrNothing?: boolean;
}

export interface WorkItem {
  id: string;
  repo: string;
  issue: string;
  dependsOn: string[];
  scope: string;
  produces: string[];
  consumes: string[];
}

interface RequestBase {
  issue: string;
  surface?: string;
  component?: string;
  intent: string;
  handoff: Handoff;
}

/** A request for one repository (the default `kind`). */
export interface SingleImplementationRequest extends RequestBase {
  kind: 'single';
  evidence: Evidence[];
  diagnosis?: Diagnosis;
  constraints: Constraints;
}

/** A multi-repo parent request (B 6.2): one work item per repository plus a merge order. */
export interface ParentImplementationRequest extends RequestBase {
  kind: 'parent';
  workItems: WorkItem[];
  mergeOrder: string[];
}

export type ImplementationRequest = SingleImplementationRequest | ParentImplementationRequest;

/** What `buildImplementationRequest` accepts: the parsed shape, with `kind` optional for single requests. */
export type ImplementationRequestInput =
  | (Omit<SingleImplementationRequest, 'kind'> & { kind?: 'single' })
  | ParentImplementationRequest;

export class ImplementationRequestParseError extends Error {
  constructor(message: string) {
    super(`Invalid implementation request: ${message}`);
    this.name = 'ImplementationRequestParseError';
  }
}

/** Validate an implementation request against the XSD. Never throws. */
export function validateImplementationRequest(xml: string): Promise<ValidationResult> {
  return validateXsd(xml, IMPLEMENTATION_REQUEST_XSD);
}

// ---------------------------------------------------------------------------------------------
// Build

export function buildImplementationRequest(input: ImplementationRequestInput): string {
  const attrs = attributes([
    ['xmlns', IMPLEMENTATION_REQUEST_NAMESPACE],
    ['issue', input.issue],
    ['surface', input.surface],
    ['component', input.component],
    ['kind', input.kind === 'parent' ? 'parent' : undefined],
  ]);
  const body: string[] = [`  <intent>${text(input.intent)}</intent>`];
  if (input.kind === 'parent') {
    body.push('  <workItems>');
    for (const wi of input.workItems) {
      body.push(
        `    <workItem${attributes([
          ['id', wi.id],
          ['repo', wi.repo],
          ['issue', wi.issue],
          ['dependsOn', wi.dependsOn.length > 0 ? wi.dependsOn.join(' ') : undefined],
        ])}>`,
        `      <scope>${text(wi.scope)}</scope>`,
        ...wi.produces.map((c) => `      <produces${attributes([['contract', c]])} />`),
        ...wi.consumes.map((c) => `      <consumes${attributes([['contract', c]])} />`),
        '    </workItem>',
      );
    }
    body.push('  </workItems>', `  <mergeOrder>${text(input.mergeOrder.join(' '))}</mergeOrder>`);
  } else {
    body.push('  <evidence>', ...input.evidence.map(buildEvidence), '  </evidence>');
    if (input.diagnosis) {
      const d = input.diagnosis;
      body.push(
        `  <diagnosis${attributes([['confidence', d.confidence], ['by', d.by]])}>`,
        ...d.files.map((f) => `    <file${attributes([['path', f.path]])}>${text(f.note)}</file>`),
        '  </diagnosis>',
      );
    }
    const c = input.constraints;
    body.push(
      '  <constraints>',
      `    <scope>${text(c.scope)}</scope>`,
      `    <tests${attributes([['required', String(c.tests.required)]])}>${text(c.tests.text)}</tests>`,
      ...c.forbidden.map((f) => `    <forbidden>${text(f)}</forbidden>`),
      '  </constraints>',
    );
  }
  const h = input.handoff;
  body.push(
    `  <handoff${attributes([
      ['mode', h.mode],
      ['branch', h.branch],
      ['base', h.base],
      ['autonomy', String(h.autonomy)],
      ['allOrNothing', h.allOrNothing === undefined ? undefined : String(h.allOrNothing)],
    ])} />`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<implementation-request${attrs}>\n${body.join('\n')}\n</implementation-request>\n`;
}

function buildEvidence(e: Evidence): string {
  switch (e.kind) {
    case 'report':
      return `    <report${attributes([['source', e.source], ['channel', e.channel], ['reporter', e.reporter], ['ts', e.ts]])}>${text(e.text)}</report>`;
    case 'screenshot':
      return `    <screenshot${attributes([['ref', e.ref]])} />`;
    case 'alert': {
      const a = attributes([
        ['none', e.none === undefined ? undefined : String(e.none)],
        ['source', e.source],
        ['ref', e.ref],
      ]);
      return e.text === undefined ? `    <alert${a} />` : `    <alert${a}>${text(e.text)}</alert>`;
    }
  }
}

function attributes(pairs: ReadonlyArray<readonly [string, string | undefined]>): string {
  return pairs.map(([k, v]) => (v === undefined ? '' : ` ${k}="${escape(v, true)}"`)).join('');
}

function text(value: string): string {
  return escape(collapse(value), false);
}

function escape(value: string, inAttribute: boolean): string {
  const out = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return inAttribute ? out.replace(/"/g, '&quot;').replace(/\s+/g, ' ') : out;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Parse

/**
 * Parse an implementation request into a typed object. Checks the shape the XSD cannot (the
 * content must match `@kind`) but does not run the XSD; call `validateImplementationRequest` for that.
 * Throws ImplementationRequestParseError for malformed XML or a document that is not a request.
 */
export function parseImplementationRequest(xml: string): ImplementationRequest {
  let root: Element | null;
  try {
    root = parseXmlDocument(xml).documentElement;
  } catch (err) {
    throw new ImplementationRequestParseError(`malformed XML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!root || root.localName !== 'implementation-request' || root.namespaceURI !== IMPLEMENTATION_REQUEST_NAMESPACE) {
    throw new ImplementationRequestParseError(`root element must be <implementation-request xmlns="${IMPLEMENTATION_REQUEST_NAMESPACE}">`);
  }
  const issue = requiredAttr(root, 'issue');
  const kindAttr = root.getAttribute('kind') ?? 'single';
  if (kindAttr !== 'single' && kindAttr !== 'parent') throw new ImplementationRequestParseError(`kind "${kindAttr}" must be single or parent`);

  const base = {
    issue,
    ...optional('surface', root.getAttribute('surface')),
    ...optional('component', root.getAttribute('component')),
    intent: collapse(requiredChild(root, 'intent').textContent ?? ''),
    handoff: parseHandoff(requiredChild(root, 'handoff')),
  };

  if (kindAttr === 'parent') {
    const forbidden = ['evidence', 'diagnosis', 'constraints'].find((n) => child(root, n));
    if (forbidden) throw new ImplementationRequestParseError(`a parent request must not contain <${forbidden}>`);
    return {
      kind: 'parent',
      ...base,
      workItems: children(requiredChild(root, 'workItems'), 'workItem').map(parseWorkItem),
      mergeOrder: tokens(requiredChild(root, 'mergeOrder').textContent),
    };
  }
  const forbidden = ['workItems', 'mergeOrder'].find((n) => child(root, n));
  if (forbidden) throw new ImplementationRequestParseError(`a single request must not contain <${forbidden}> (set kind="parent")`);
  const diagnosisEl = child(root, 'diagnosis');
  return {
    kind: 'single',
    ...base,
    evidence: Array.from(requiredChild(root, 'evidence').childNodes)
      .filter(isElement)
      .map(parseEvidence),
    ...(diagnosisEl ? { diagnosis: parseDiagnosis(diagnosisEl) } : {}),
    constraints: parseConstraints(requiredChild(root, 'constraints')),
  };
}

function parseEvidence(el: Element): Evidence {
  switch (el.localName) {
    case 'report':
      return {
        kind: 'report',
        source: requiredAttr(el, 'source'),
        ...optional('channel', el.getAttribute('channel')),
        ...optional('reporter', el.getAttribute('reporter')),
        ...optional('ts', el.getAttribute('ts')),
        text: collapse(el.textContent ?? ''),
      };
    case 'screenshot':
      return { kind: 'screenshot', ref: requiredAttr(el, 'ref') };
    case 'alert': {
      const none = el.getAttribute('none');
      const body = collapse(el.textContent ?? '');
      return {
        kind: 'alert',
        ...(none === null ? {} : { none: bool(none, 'alert/@none') }),
        ...optional('source', el.getAttribute('source')),
        ...optional('ref', el.getAttribute('ref')),
        ...(body === '' ? {} : { text: body }),
      };
    }
    default:
      throw new ImplementationRequestParseError(`unexpected <${el.localName}> in <evidence>`);
  }
}

function parseDiagnosis(el: Element): Diagnosis {
  const confidence = requiredAttr(el, 'confidence');
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    throw new ImplementationRequestParseError(`diagnosis confidence "${confidence}" must be low, medium, or high`);
  }
  return {
    confidence,
    by: requiredAttr(el, 'by'),
    files: children(el, 'file').map((f) => ({ path: requiredAttr(f, 'path'), note: collapse(f.textContent ?? '') })),
  };
}

function parseConstraints(el: Element): Constraints {
  const tests = requiredChild(el, 'tests');
  return {
    scope: collapse(requiredChild(el, 'scope').textContent ?? ''),
    tests: { required: bool(requiredAttr(tests, 'required'), 'tests/@required'), text: collapse(tests.textContent ?? '') },
    forbidden: children(el, 'forbidden').map((f) => collapse(f.textContent ?? '')),
  };
}

function parseHandoff(el: Element): Handoff {
  const mode = requiredAttr(el, 'mode');
  if (mode !== 'review' && mode !== 'auto') throw new ImplementationRequestParseError(`handoff mode "${mode}" must be review or auto`);
  const autonomy = Number(requiredAttr(el, 'autonomy'));
  if (autonomy !== 0 && autonomy !== 1 && autonomy !== 2 && autonomy !== 3) {
    throw new ImplementationRequestParseError('handoff autonomy must be 0, 1, 2, or 3');
  }
  const allOrNothing = el.getAttribute('allOrNothing');
  return {
    mode,
    autonomy,
    ...optional('branch', el.getAttribute('branch')),
    ...optional('base', el.getAttribute('base')),
    ...(allOrNothing === null ? {} : { allOrNothing: bool(allOrNothing, 'handoff/@allOrNothing') }),
  };
}

function parseWorkItem(el: Element): WorkItem {
  return {
    id: requiredAttr(el, 'id'),
    repo: requiredAttr(el, 'repo'),
    issue: requiredAttr(el, 'issue'),
    dependsOn: tokens(el.getAttribute('dependsOn')),
    scope: collapse(requiredChild(el, 'scope').textContent ?? ''),
    produces: children(el, 'produces').map((c) => requiredAttr(c, 'contract')),
    consumes: children(el, 'consumes').map((c) => requiredAttr(c, 'contract')),
  };
}

function isElement(node: { nodeType: number }): node is Element {
  return node.nodeType === 1;
}

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.childNodes).filter(isElement).filter((e) => e.localName === name);
}

function child(parent: Element, name: string): Element | undefined {
  return children(parent, name)[0];
}

function requiredChild(parent: Element, name: string): Element {
  const el = child(parent, name);
  if (!el) throw new ImplementationRequestParseError(`<${parent.localName}> is missing required <${name}>`);
  return el;
}

function requiredAttr(el: Element, name: string): string {
  const value = el.getAttribute(name);
  if (value === null || value === '') throw new ImplementationRequestParseError(`<${el.localName}> is missing required attribute ${name}`);
  return value;
}

function optional<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return value === null ? {} : ({ [key]: value } as { [P in K]?: string });
}

function bool(value: string, where: string): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ImplementationRequestParseError(`${where} must be true or false`);
}

function tokens(value: string | null): string[] {
  return (value ?? '').split(/\s+/).filter((t) => t !== '');
}
