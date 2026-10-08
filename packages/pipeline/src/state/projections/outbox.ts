// Entry point for the outbox hook; the registry and the per-target modules live in outbox/.
// `applyProjections` imports from here, so a test can swap the hook by mocking this one module.

export { outboxFor, type IncidentChange, type TargetRows } from './outbox/index.ts';
