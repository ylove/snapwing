import { Clipboard, getPreferenceValues, getSelectedText, open } from '@raycast/api';
import {
  CaptureAuthError,
  CaptureError,
  createCaptureClient,
  renderChoices,
  type CaptureClient,
  type Choice,
  type LookupResponse,
  type SendOptions,
} from './capture.ts';
import { defaultScreenshotDeps, loadImage, newestScreenshot, type ScreenshotDeps } from './screenshot.ts';

export const AUTH_MESSAGE = 'Your Snapwing token is wrong or was revoked';
const NO_SELECTION = 'Select some text first, then run Fix from Selection.';
const NO_IMAGE = 'No screenshot found in the screenshots folder, and no image on the clipboard.';

const SEND_OPTIONS: SendOptions = { source: 'raycast' };

export interface Preferences {
  readonly endpoint: string;
  readonly token: string;
}

export type ChooseStep = {
  readonly kind: 'choose';
  readonly captureId: string;
  readonly response: LookupResponse;
  readonly title: string;
  readonly choices: readonly Choice[];
};

/** What the view does next. Every path ends in `done` (a HUD), `auth` or `failed` (an inline message). */
export type Step =
  | ChooseStep
  | { readonly kind: 'done'; readonly hud: string }
  | { readonly kind: 'auth'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface FlowDeps {
  readonly client: CaptureClient;
  readonly openUrl: (url: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Polls of a pending capture before giving up; default 20. */
  readonly maxPolls?: number;
  /** Default 1500. */
  readonly pollMs?: number;
}

export function createFlowDeps(prefs: Preferences = getPreferenceValues<Preferences>()): FlowDeps {
  return {
    client: createCaptureClient({ endpoint: prefs.endpoint.trim(), token: prefs.token.trim() }),
    openUrl: (url) => open(url),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Maps a thrown error to a step; only a token problem gets the preferences action. */
export function failure(cause: unknown): Step {
  if (cause instanceof CaptureAuthError) return { kind: 'auth', message: AUTH_MESSAGE };
  if (cause instanceof CaptureError) return { kind: 'failed', message: cause.message };
  return { kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
}

async function settle(deps: FlowDeps, first: LookupResponse): Promise<LookupResponse> {
  let response = first;
  const maxPolls = deps.maxPolls ?? 20;
  for (let i = 0; response.kind === 'pending' && i < maxPolls; i += 1) {
    await deps.sleep(deps.pollMs ?? 1500);
    response = await deps.client.poll(response.captureId);
  }
  return response;
}

/** The step for a response: a final HUD, a failure for one still pending, or choices to pick from. */
export function stepFor(response: LookupResponse): Step {
  switch (response.kind) {
    case 'filed':
      return { kind: 'done', hud: `Filed as ${response.issueKey}` };
    case 'not-filed':
      return { kind: 'done', hud: `Not filed. ${response.reason}` };
    case 'pending':
      return { kind: 'failed', message: 'Snapwing is still working on it. Try again in a minute.' };
    case 'tracked':
    case 'new':
    case 'which-surface':
    case 'fix-preview': {
      const rendered = renderChoices(response);
      return {
        kind: 'choose',
        captureId: response.captureId,
        response,
        title: rendered.lines.join(' '),
        choices: rendered.choices.map(({ id, label }) => ({ id, label })),
      };
    }
  }
}

async function advance(deps: FlowDeps, response: LookupResponse): Promise<Step> {
  return stepFor(await settle(deps, response));
}

export async function sendSelection(deps: FlowDeps, getText: () => Promise<string> = getSelectedText): Promise<Step> {
  let text: string;
  try {
    text = await getText();
  } catch {
    return { kind: 'failed', message: NO_SELECTION };
  }
  if (text.trim().length === 0) return { kind: 'failed', message: NO_SELECTION };
  try {
    return await advance(deps, await deps.client.sendText(text, SEND_OPTIONS));
  } catch (cause) {
    return failure(cause);
  }
}

/** The clipboard's image file, when the clipboard holds one. */
async function clipboardImagePath(): Promise<string | undefined> {
  try {
    const { file } = await Clipboard.read();
    if (file === undefined) return undefined;
    return file.startsWith('file://') ? decodeURIComponent(new URL(file).pathname) : file;
  } catch {
    return undefined;
  }
}

export async function sendScreenshot(
  deps: FlowDeps,
  files: ScreenshotDeps = defaultScreenshotDeps,
  clipboardImage: () => Promise<string | undefined> = clipboardImagePath,
): Promise<Step> {
  try {
    const path = (await newestScreenshot(files)) ?? (await clipboardImage());
    const loaded = path === undefined ? undefined : await loadImage(path, files);
    if (loaded === undefined) return { kind: 'failed', message: NO_IMAGE };
    return await advance(deps, await deps.client.sendImage(loaded.image, loaded.mimeType, SEND_OPTIONS));
  } catch (cause) {
    return failure(cause);
  }
}

/** Only an https URL is opened: a server-supplied link must not launch another scheme. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The user picked a choice on a `choose` step. */
export async function choose(deps: FlowDeps, step: ChooseStep, choiceId: string): Promise<Step> {
  try {
    const response = step.response;
    if (response.kind === 'tracked') {
      if (choiceId === 'open' && isHttpsUrl(response.url)) await deps.openUrl(response.url);
      return { kind: 'done', hud: `Already tracked as ${response.issueKey}` };
    }
    return await advance(deps, await deps.client.answer(step.captureId, choiceId));
  } catch (cause) {
    return failure(cause);
  }
}
