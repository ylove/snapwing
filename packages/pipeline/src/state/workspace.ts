// The install's workspace (single tenant, B 3 `workspaces`): the id every event, artifact, and outbox
// row is stamped with. The config cache resolves it the same way (config.ts); the composition root
// (`app/src/server/compose.ts`) needs it at startup, before anything is appended.

import type { OpenedState, StatePort } from '../ports/state.ts';
import { createDefaultWorkspace, installWorkspaceId } from './config.ts';
import { inTransaction } from './context.ts';
import { StateStore } from './store.ts';

/**
 * The install's one workspace id, creating the `default` workspace when there is none. Rejects with
 * `ConfigWorkspaceAmbiguousError` when there are several.
 */
export async function ensureInstallWorkspace(state: StatePort | OpenedState): Promise<string> {
  if (!(state instanceof StateStore)) throw new TypeError('ensureInstallWorkspace needs the store openState returned');
  return inTransaction(state.ctx, async (tx) => (await installWorkspaceId(tx)) ?? (await createDefaultWorkspace(tx)));
}
