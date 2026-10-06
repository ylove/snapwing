import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clipboard, getPreferenceValues, getSelectedText, open } from '@raycast/api';
import { CAPTURE_ROUTES } from '@snapwing/capture-client/wire.ts';
import { AUTH_MESSAGE, choose, createFlowDeps, sendScreenshot, sendSelection, type ChooseStep } from '../../src/flow.ts';
import type { ScreenshotDeps } from '../../src/screenshot.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly body: Record<string, unknown> | undefined;
}

let calls: Call[];
let replies: Array<{ status: number; body: unknown }>;

function json(status: number, body: unknown) {
  replies.push({ status, body });
}

beforeEach(() => {
  calls = [];
  replies = [];
  vi.mocked(getPreferenceValues).mockReturnValue({ endpoint: ' http://localhost:3000/ ', token: ' swc_abc ' });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unexpected request to ${url}`);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const deps = () => ({ ...createFlowDeps(), sleep: async () => undefined });

describe('Fix from Selection', () => {
  it('sends the selection as text from raycast, with the bearer token', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('TypeError: x is undefined\n  at src/cart/total.ts:12');
    json(200, { kind: 'filed', captureId: 'c1', issueKey: 'WEB-1042', url: 'https://jira.example/WEB-1042' });
    const step = await sendSelection(deps());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `http://localhost:3000${CAPTURE_ROUTES.send}`,
      method: 'POST',
      auth: 'Bearer swc_abc',
      body: { source: 'raycast', text: 'TypeError: x is undefined\n  at src/cart/total.ts:12' },
    });
    expect(step).toEqual({ kind: 'done', hud: 'Filed as WEB-1042' });
  });

  it('asks for a selection when there is none, without calling the server', async () => {
    vi.mocked(getSelectedText).mockRejectedValue(new Error('Unable to get selected text'));
    expect((await sendSelection(deps())).kind).toBe('failed');
    vi.mocked(getSelectedText).mockResolvedValue('   ');
    expect((await sendSelection(deps())).kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('responses', () => {
  it('tracked: shows Open it and Not now, then a HUD naming the ticket', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    json(200, {
      kind: 'tracked',
      captureId: 'c2',
      issueKey: 'WEB-830',
      summary: 'Cart total NaN',
      status: 'open',
      assignee: 'Dana',
      url: 'https://jira.example/WEB-830',
    });
    const step = await sendSelection(deps());
    if (step.kind !== 'choose') throw new Error('expected choose');
    expect(step.title).toBe('Already tracked as WEB-830 (open, assigned to Dana). Open it?');
    expect(step.choices.map((c) => c.label)).toEqual(['Open it', 'Not now']);

    expect(await choose(deps(), step, 'open')).toEqual({ kind: 'done', hud: 'Already tracked as WEB-830' });
    expect(open).toHaveBeenCalledWith('https://jira.example/WEB-830');
    vi.mocked(open).mockClear();
    expect(await choose(deps(), step, 'dismiss')).toEqual({ kind: 'done', hud: 'Already tracked as WEB-830' });
    expect(open).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('new: shows the server wording, and the answer files it', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    json(200, {
      kind: 'new',
      captureId: 'c3',
      surface: { id: 'web', label: 'the website' },
      evidence: 'src/cart/...',
      choices: [
        { id: 'file', label: 'File it' },
        { id: 'skip', label: 'Skip' },
      ],
    });
    const step = await sendSelection(deps());
    if (step.kind !== 'choose') throw new Error('expected choose');
    expect(step.title).toBe('New. Looks like the website (from src/cart/...). File it?');
    json(200, { kind: 'filed', captureId: 'c3', issueKey: 'WEB-1043', url: 'https://jira.example/WEB-1043' });
    expect(await choose(deps(), step, 'file')).toEqual({ kind: 'done', hud: 'Filed as WEB-1043' });
    expect(calls[1]).toMatchObject({
      url: `http://localhost:3000${CAPTURE_ROUTES.answer('c3')}`,
      method: 'POST',
      body: { choiceId: 'file' },
    });
  });

  it('which-surface: lists the surfaces, and a refusal reads as Not filed', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    json(200, {
      kind: 'which-surface',
      captureId: 'c4',
      choices: [
        { id: 'web', label: 'Website' },
        { id: 'api', label: 'API' },
      ],
    });
    const step = await sendSelection(deps());
    if (step.kind !== 'choose') throw new Error('expected choose');
    expect(step.choices.map((c) => c.label)).toEqual(['Website', 'API']);
    json(200, { kind: 'not-filed', captureId: 'c4', reason: 'Dropped at your request.' });
    expect(await choose(deps(), step, 'api')).toEqual({ kind: 'done', hud: 'Not filed. Dropped at your request.' });
  });

  it('pending: polls until the response settles', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    json(200, { kind: 'pending', captureId: 'c5' });
    json(200, { kind: 'pending', captureId: 'c5' });
    json(200, { kind: 'filed', captureId: 'c5', issueKey: 'WEB-7', url: 'https://jira.example/WEB-7' });
    expect(await sendSelection(deps())).toEqual({ kind: 'done', hud: 'Filed as WEB-7' });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET']);
    expect(calls[1]?.url).toBe(`http://localhost:3000${CAPTURE_ROUTES.poll('c5')}`);
  });

  it('pending forever: fails with a retry message', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    for (let i = 0; i < 4; i += 1) json(200, { kind: 'pending', captureId: 'c6' });
    const step = await sendSelection({ ...deps(), maxPolls: 3 });
    expect(step.kind).toBe('failed');
  });
});

describe('errors', () => {
  it('a 401 says the token is wrong or revoked and routes to preferences', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    json(401, { error: 'unauthorized' });
    expect(await sendSelection(deps())).toEqual({ kind: 'auth', message: 'Your Snapwing token is wrong or was revoked' });
    expect(AUTH_MESSAGE).toBe('Your Snapwing token is wrong or was revoked');
  });

  it('a 401 on the answer call is the same step', async () => {
    const step: ChooseStep = {
      kind: 'choose',
      captureId: 'c7',
      title: 'New.',
      choices: [{ id: 'file', label: 'File it' }],
      response: { kind: 'new', captureId: 'c7', surface: { id: 'web', label: 'the website' }, choices: [] },
    };
    json(401, {});
    expect((await choose(deps(), step, 'file')).kind).toBe('auth');
  });

  it('a server error is an inline failure, not an auth step', async () => {
    vi.mocked(getSelectedText).mockResolvedValue('boom');
    json(500, {});
    const step = await sendSelection(deps());
    expect(step).toMatchObject({ kind: 'failed' });
  });
});

describe('Send Screenshot', () => {
  const PNG = new Uint8Array([137, 80, 78, 71]);
  const mtimes: Record<string, number> = {
    '/shots/Screenshot 1.png': 100,
    '/shots/Screenshot 2.png': 300,
    '/shots/Screenshot 3.jpg': 200,
    '/shots/notes.txt': 900,
  };
  const files = (names: readonly string[]): ScreenshotDeps => ({
    screenshotsDir: async () => '/shots',
    listDir: async () => names,
    mtimeMs: async (path) => mtimes[path] ?? 0,
    readFile: async () => PNG,
  });

  it('sends the newest image in the screenshots folder, ignoring other files', async () => {
    json(200, { kind: 'filed', captureId: 'i1', issueKey: 'WEB-9', url: 'https://jira.example/WEB-9' });
    const step = await sendScreenshot(
      deps(),
      files(['Screenshot 1.png', 'Screenshot 2.png', 'Screenshot 3.jpg', 'notes.txt', '.hidden.png']),
    );
    expect(step).toEqual({ kind: 'done', hud: 'Filed as WEB-9' });
    expect(calls[0]?.body).toEqual({
      source: 'raycast',
      image: Buffer.from(PNG).toString('base64'),
      mimeType: 'image/png',
    });
    expect(Clipboard.read).not.toHaveBeenCalled();
  });

  it('uses the jpeg mime type for a jpg', async () => {
    json(200, { kind: 'pending', captureId: 'i2' });
    json(200, { kind: 'filed', captureId: 'i2', issueKey: 'WEB-10', url: 'u' });
    await sendScreenshot(deps(), files(['Screenshot 3.jpg']));
    expect(calls[0]?.body?.['mimeType']).toBe('image/jpeg');
  });

  it('falls back to the clipboard image when the folder has none', async () => {
    json(200, { kind: 'filed', captureId: 'i3', issueKey: 'WEB-11', url: 'u' });
    vi.mocked(Clipboard.read).mockResolvedValue({ text: '', file: 'file:///shots/Screenshot%202.png' });
    const step = await sendScreenshot(deps(), files(['notes.txt']));
    expect(step).toEqual({ kind: 'done', hud: 'Filed as WEB-11' });
    expect(calls[0]?.body?.['mimeType']).toBe('image/png');
  });

  it('falls back to the clipboard when the folder is unreadable', async () => {
    json(200, { kind: 'filed', captureId: 'i4', issueKey: 'WEB-12', url: 'u' });
    vi.mocked(Clipboard.read).mockResolvedValue({ text: '', file: '/shots/Screenshot 2.png' });
    const unreadable: ScreenshotDeps = {
      ...files([]),
      listDir: async () => {
        throw new Error('EACCES');
      },
    };
    expect((await sendScreenshot(deps(), unreadable)).kind).toBe('done');
  });

  it('reports no image when neither source has one, without calling the server', async () => {
    vi.mocked(Clipboard.read).mockResolvedValue({ text: 'just text' });
    const step = await sendScreenshot(deps(), files([]));
    expect(step.kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('a 401 on an image is the auth step', async () => {
    json(403, {});
    expect((await sendScreenshot(deps(), files(['Screenshot 1.png']))).kind).toBe('auth');
  });
});
