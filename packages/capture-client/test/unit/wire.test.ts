import { describe, expect, it } from 'vitest';
import {
  CAPTURE_ROUTES,
  CAPTURE_SURFACE_MAX_CHARS,
  CAPTURE_TEXT_MAX_CHARS,
  CAPTURE_URL_MAX_CHARS,
  validateAnswerRequest,
  validateCaptureRequest,
  validateChoice,
  validateHealthResult,
  validateLookupResponse,
  validateStopResult,
  validateTicketStatus,
} from '../../src/wire.ts';

describe('validateCaptureRequest', () => {
  it('caps text, context.url and surface', () => {
    expect(validateCaptureRequest({ source: 'cli', text: 'x'.repeat(CAPTURE_TEXT_MAX_CHARS) }).ok).toBe(true);
    expect(validateCaptureRequest({ source: 'cli', text: 'x'.repeat(CAPTURE_TEXT_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateCaptureRequest({ source: 'cli', text: 'x', context: { url: 'u'.repeat(CAPTURE_URL_MAX_CHARS) } }).ok).toBe(true);
    expect(validateCaptureRequest({ source: 'cli', text: 'x', context: { url: 'u'.repeat(CAPTURE_URL_MAX_CHARS + 1) } }).ok).toBe(false);
    expect(validateCaptureRequest({ source: 'cli', text: 'x', surface: 's'.repeat(CAPTURE_SURFACE_MAX_CHARS) }).ok).toBe(true);
    expect(validateCaptureRequest({ source: 'cli', text: 'x', surface: 's'.repeat(CAPTURE_SURFACE_MAX_CHARS + 1) }).ok).toBe(false);
  });

  it('accepts text with surface and context', () => {
    const r = validateCaptureRequest({
      text: 'checkout is blank',
      source: 'raycast',
      surface: 'web',
      context: { url: 'http://localhost:3000/cart' },
    });
    expect(r).toEqual({
      ok: true,
      value: { text: 'checkout is blank', source: 'raycast', surface: 'web', context: { url: 'http://localhost:3000/cart' } },
    });
  });

  it('accepts an image with a mime type and drops unknown keys', () => {
    const r = validateCaptureRequest({ image: 'aGVsbG8=', mimeType: 'image/png', source: 'cli', extra: 1 });
    expect(r).toEqual({ ok: true, value: { image: 'aGVsbG8=', mimeType: 'image/png', source: 'cli' } });
  });

  it.each([
    ['not an object', 'x', 'request must be an object'],
    ['array', [], 'request must be an object'],
    ['bad source', { text: 'a', source: 'slack' }, "source must be 'cli' or 'raycast'"],
    ['missing source', { text: 'a' }, "source must be 'cli' or 'raycast'"],
    ['neither text nor image', { source: 'cli' }, 'exactly one of text or image is required'],
    ['both text and image', { text: 'a', image: 'aGk=', mimeType: 'image/png', source: 'cli' }, 'exactly one of text or image is required'],
    ['empty text', { text: '', source: 'cli' }, 'text must be a non-empty string'],
    ['non-string text', { text: 4, source: 'cli' }, 'text must be a non-empty string'],
    ['image not base64', { image: 'not base64!', mimeType: 'image/png', source: 'cli' }, 'image must be base64'],
    ['image without mime type', { image: 'aGk=', source: 'cli' }, 'mimeType must be a non-empty string'],
    ['non-image mime type', { image: 'aGk=', mimeType: 'text/plain', source: 'cli' }, 'mimeType must be an image type'],
    ['empty surface', { text: 'a', source: 'cli', surface: '' }, 'surface must be a non-empty string when present'],
    ['bad context', { text: 'a', source: 'cli', context: 'x' }, 'context must be an object'],
    ['bad context url', { text: 'a', source: 'cli', context: { url: 3 } }, 'context.url must be a non-empty string when present'],
  ])('rejects %s', (_name, input, error) => {
    expect(validateCaptureRequest(input)).toEqual({ ok: false, error });
  });
});

describe('validateLookupResponse', () => {
  const valid = [
    { kind: 'tracked', captureId: 'c1', issueKey: 'WEB-830', summary: 'Cart blank', status: 'open', assignee: 'Dana', url: 'http://localhost/browse/WEB-830' },
    { kind: 'tracked', captureId: 'c1', issueKey: 'WEB-830', summary: 'Cart blank', status: 'open', url: 'http://x/y' },
    { kind: 'new', captureId: 'c2', surface: { id: 'web', label: 'the website' }, evidence: 'src/cart/...', choices: [{ id: 'file', label: 'File it' }] },
    { kind: 'new', captureId: 'c2', surface: { id: 'web', label: 'the website' }, choices: [] },
    { kind: 'which-surface', captureId: 'c3', choices: [{ id: 'web', label: 'Website' }, { id: 'api', label: 'API' }] },
    { kind: 'fix-preview', captureId: 'c7', summary: 'Cart total blank', choices: [{ id: 'approve_fix', label: 'Fix it' }, { id: 'ticket_only', label: 'Ticket only' }] },
    { kind: 'filed', captureId: 'c4', issueKey: 'WEB-1', url: 'http://x/WEB-1' },
    { kind: 'not-filed', captureId: 'c5', reason: 'Duplicate of WEB-2' },
    { kind: 'pending', captureId: 'c6' },
  ];

  it.each(valid)('accepts %j unchanged', (input) => {
    expect(validateLookupResponse(input)).toEqual({ ok: true, value: input });
  });

  it('drops unknown keys', () => {
    expect(validateLookupResponse({ kind: 'pending', captureId: 'c', secret: 'x' })).toEqual({
      ok: true,
      value: { kind: 'pending', captureId: 'c' },
    });
  });

  it.each([
    ['not an object', null, 'response must be an object'],
    ['no captureId', { kind: 'pending' }, 'captureId must be a non-empty string'],
    ['unknown kind', { kind: 'maybe', captureId: 'c' }, 'kind must be one of tracked, new, which-surface, fix-preview, filed, not-filed, pending'],
    ['tracked without key', { kind: 'tracked', captureId: 'c', summary: 's', status: 'o', url: 'u' }, 'issueKey must be a non-empty string'],
    ['tracked without summary', { kind: 'tracked', captureId: 'c', issueKey: 'K-1', status: 'o', url: 'u' }, 'summary must be a non-empty string'],
    ['tracked without status', { kind: 'tracked', captureId: 'c', issueKey: 'K-1', summary: 's', url: 'u' }, 'status must be a non-empty string'],
    ['tracked bad assignee', { kind: 'tracked', captureId: 'c', issueKey: 'K-1', summary: 's', status: 'o', url: 'u', assignee: 1 }, 'assignee must be a non-empty string when present'],
    ['tracked without url', { kind: 'tracked', captureId: 'c', issueKey: 'K-1', summary: 's', status: 'o' }, 'url must be a non-empty string'],
    ['new without surface', { kind: 'new', captureId: 'c', choices: [] }, 'surface must be an object'],
    ['new surface without id', { kind: 'new', captureId: 'c', surface: { label: 'x' }, choices: [] }, 'surface.id must be a non-empty string'],
    ['new surface without label', { kind: 'new', captureId: 'c', surface: { id: 'x' }, choices: [] }, 'surface.label must be a non-empty string'],
    ['new bad evidence', { kind: 'new', captureId: 'c', surface: { id: 'x', label: 'y' }, evidence: 2, choices: [] }, 'evidence must be a non-empty string when present'],
    ['new without choices', { kind: 'new', captureId: 'c', surface: { id: 'x', label: 'y' } }, 'choices must be an array'],
    ['which-surface bad choice', { kind: 'which-surface', captureId: 'c', choices: [{ id: 'a' }] }, 'choices[0].label must be a non-empty string'],
    ['which-surface non-object choice', { kind: 'which-surface', captureId: 'c', choices: ['a'] }, 'choices[0] must be an object'],
    ['fix-preview without summary', { kind: 'fix-preview', captureId: 'c', choices: [] }, 'summary must be a non-empty string'],
    ['fix-preview without choices', { kind: 'fix-preview', captureId: 'c', summary: 's' }, 'choices must be an array'],
    ['filed without key', { kind: 'filed', captureId: 'c', url: 'u' }, 'issueKey must be a non-empty string'],
    ['filed without url', { kind: 'filed', captureId: 'c', issueKey: 'K-1' }, 'url must be a non-empty string'],
    ['not-filed without reason', { kind: 'not-filed', captureId: 'c' }, 'reason must be a non-empty string'],
  ])('rejects %s', (_name, input, error) => {
    expect(validateLookupResponse(input)).toEqual({ ok: false, error });
  });
});

describe('small validators', () => {
  it('validates a choice', () => {
    expect(validateChoice({ id: 'a', label: 'A', x: 1 })).toEqual({ ok: true, value: { id: 'a', label: 'A' } });
    expect(validateChoice({ id: 'a' })).toEqual({ ok: false, error: 'choice.label must be a non-empty string' });
    expect(validateChoice(5)).toEqual({ ok: false, error: 'choice must be an object' });
  });

  it('validates an answer request', () => {
    expect(validateAnswerRequest({ choiceId: 'file' })).toEqual({ ok: true, value: { choiceId: 'file' } });
    expect(validateAnswerRequest({ choiceId: '' }).ok).toBe(false);
    expect(validateAnswerRequest(null).ok).toBe(false);
  });

  it('validates a ticket status', () => {
    const full = {
      issueKey: 'WEB-9',
      summary: 's',
      status: 'in progress',
      assignee: 'Dana',
      url: 'u',
      pullRequest: { url: 'p', state: 'open' },
    };
    expect(validateTicketStatus(full)).toEqual({ ok: true, value: full });
    expect(validateTicketStatus({ issueKey: 'WEB-9', summary: 's', status: 'x', url: 'u' }).ok).toBe(true);
    expect(validateTicketStatus({ ...full, pullRequest: 'p' })).toEqual({ ok: false, error: 'pullRequest must be an object' });
    expect(validateTicketStatus({ ...full, pullRequest: { url: 'p' } }).ok).toBe(false);
    expect(validateTicketStatus({ ...full, pullRequest: { state: 'p' } }).ok).toBe(false);
    expect(validateTicketStatus({ ...full, summary: '' }).ok).toBe(false);
    expect(validateTicketStatus([]).ok).toBe(false);
  });

  it('validates stop and health results', () => {
    expect(validateStopResult({ issueKey: 'K-1', stopped: true })).toEqual({ ok: true, value: { issueKey: 'K-1', stopped: true } });
    expect(validateStopResult({ issueKey: 'K-1', stopped: 'yes' }).ok).toBe(false);
    expect(validateStopResult({ stopped: true }).ok).toBe(false);
    expect(validateStopResult(1).ok).toBe(false);
    expect(validateHealthResult({ ok: true })).toEqual({ ok: true, value: { ok: true } });
    expect(validateHealthResult({ ok: 1 }).ok).toBe(false);
    expect(validateHealthResult('up').ok).toBe(false);
    expect(
      validateHealthResult({
        ok: true,
        platforms: [
          { id: 'slack', ok: true, mode: 'full' },
          { id: 'teams', ok: true, mode: 'reduced', detail: 'no RSC grant' },
          { id: 'other', ok: false, mode: 'someday' },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        ok: true,
        platforms: [
          { id: 'slack', ok: true, mode: 'full' },
          { id: 'teams', ok: true, mode: 'reduced', detail: 'no RSC grant' },
          { id: 'other', ok: false },
        ],
      },
    });
    expect(validateHealthResult({ ok: true, platforms: {} }).ok).toBe(false);
    expect(validateHealthResult({ ok: true, platforms: [{ id: 'slack' }] }).ok).toBe(false);
  });

  it('encodes keys in routes', () => {
    expect(CAPTURE_ROUTES.status('WEB-1/../x')).toBe('/issues/WEB-1%2F..%2Fx/status');
    expect(CAPTURE_ROUTES.answer('a b')).toBe('/capture/a%20b/answer');
  });
});
