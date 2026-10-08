// The model providers' key check, as the runtime step calls it: one read-only "list the models" call
// per provider. A key in `keys` is good; anything else is refused the way that provider refuses it.
// Every key here is a fake; none looks like a real credential.

import { http, HttpResponse, type HttpHandler } from 'msw';

export const MODEL_LISTS = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
} as const;

export interface ModelKeys {
  readonly anthropic?: string;
  readonly openai?: string;
  readonly google?: string;
}

/** Every key each provider was checked with, as the request carried it. */
export interface SeenKeys {
  anthropic: string[];
  openai: string[];
  google: string[];
}

export function modelKeyHandlers(keys: ModelKeys, seen: SeenKeys = { anthropic: [], openai: [], google: [] }): HttpHandler[] {
  return [
    http.get(MODEL_LISTS.anthropic, ({ request }) => {
      const key = request.headers.get('x-api-key') ?? '';
      seen.anthropic.push(key);
      return key === keys.anthropic ? HttpResponse.json({ data: [] }) : HttpResponse.json({ error: { type: 'authentication_error' } }, { status: 401 });
    }),
    http.get(MODEL_LISTS.openai, ({ request }) => {
      const auth = request.headers.get('authorization') ?? '';
      seen.openai.push(auth);
      return auth === `Bearer ${keys.openai ?? ''}` && keys.openai !== undefined
        ? HttpResponse.json({ data: [] })
        : HttpResponse.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
    }),
    http.get(MODEL_LISTS.google, ({ request }) => {
      const key = request.headers.get('x-goog-api-key') ?? '';
      seen.google.push(key);
      return key === keys.google ? HttpResponse.json({ models: [] }) : HttpResponse.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 });
    }),
  ];
}
