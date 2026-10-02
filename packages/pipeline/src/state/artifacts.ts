// Artifacts (B 1, B 3): versioned, content-addressed. Stubs until #19.

import type { Artifact, NewArtifact } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import { NotImplementedError } from './errors.ts';

/** See `StatePort.putArtifact`. */
export async function putArtifact(_ctx: StateContext, _a: NewArtifact): Promise<{ id: string; version: number }> {
  throw new NotImplementedError('putArtifact');
}

/** See `StatePort.getArtifact`. */
export async function getArtifact(_ctx: StateContext, _id: string, _version?: number): Promise<Artifact> {
  throw new NotImplementedError('getArtifact');
}
