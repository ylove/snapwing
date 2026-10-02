// Config cache (B 1, B 3 `config_versions`). Stubs until #19.

import type { ConfigKind, ConfigVersion } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import { NotImplementedError } from './errors.ts';

/** See `StatePort.putConfigVersion`. */
export async function putConfigVersion(_ctx: StateContext, _kind: ConfigKind, _hash: string, _body: string): Promise<void> {
  throw new NotImplementedError('putConfigVersion');
}

/** See `StatePort.getConfigVersion`. */
export async function getConfigVersion(_ctx: StateContext, _kind: ConfigKind): Promise<ConfigVersion> {
  throw new NotImplementedError('getConfigVersion');
}
