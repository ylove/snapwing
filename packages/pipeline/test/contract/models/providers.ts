import { anthropicProvider } from '../../../src/models/anthropic/index.ts';
import { openaiProvider } from '../../../src/models/openai/index.ts';
import { googleProviderFactory } from '../../../src/models/google/index.ts';
import { createModelRouter, MODEL_TASK_LIST } from '../../../src/models/router.ts';
import type { ModelProviderFactory } from '../../../src/models/router.ts';

export const providers = ['anthropic', 'openai', 'google'] as const;
export type Provider = (typeof providers)[number];
export const keys = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY' } as const;
export const models = { anthropic: 'claude-haiku-4-5', openai: 'gpt-5-mini', google: 'gemini-2.5-flash' } as const;
const factories: Record<Provider, ModelProviderFactory> = { anthropic: anthropicProvider, openai: openaiProvider, google: googleProviderFactory };
export function port(provider: Provider, apiKey: string) {
  return createModelRouter({ defaultProvider: provider, rows: MODEL_TASK_LIST.map((task) => ({ task, provider, name: models[provider] })) },
    { [provider]: factories[provider] }, { [keys[provider]]: apiKey });
}
