/** The only door to `@snapwing/capture-client`, so the extension names its subpaths once. */
export { createCaptureClient } from '@snapwing/capture-client/client.ts';
export type { CaptureClient, SendOptions } from '@snapwing/capture-client/client.ts';
export { CaptureAuthError, CaptureError } from '@snapwing/capture-client/errors.ts';
export { renderChoices } from '@snapwing/capture-client/render.ts';
export type { Choice, LookupResponse } from '@snapwing/capture-client/wire.ts';
