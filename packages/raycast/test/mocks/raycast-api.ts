import { vi } from 'vitest';

/** The slice of `@raycast/api` the flow uses; tests set return values per case. */
export const getSelectedText = vi.fn<() => Promise<string>>();
export const getPreferenceValues = vi.fn<() => { endpoint: string; token: string }>(() => ({
  endpoint: 'http://localhost:3000',
  token: 'swc_test',
}));
export const open = vi.fn<(target: string) => Promise<void>>(async () => undefined);
export const showHUD = vi.fn<(title: string) => Promise<void>>(async () => undefined);
export const popToRoot = vi.fn<() => Promise<void>>(async () => undefined);
export const openExtensionPreferences = vi.fn<() => Promise<void>>(async () => undefined);
export const Clipboard = {
  read: vi.fn<() => Promise<{ text: string; file?: string }>>(async () => ({ text: '' })),
};
