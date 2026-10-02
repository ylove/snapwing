// Errors the state implementation raises beyond the port's own (contracts/state.ts).

/** A StatePort method whose implementation has not landed yet (#17, #18, #19 fill them). */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  readonly code = 'NOT_IMPLEMENTED';
  readonly method: string;

  constructor(method: string) {
    super(`state: ${method} is not implemented yet`);
    this.method = method;
  }
}

/** A migration failed while `openState` ran it (B 10: a failed migration halts startup with the reason). */
export class StateMigrationError extends Error {
  override readonly name = 'StateMigrationError';
  readonly code = 'STATE_MIGRATION_FAILED';
  /** The failing migration's name, or `undefined` when the migrator failed before running one. */
  readonly migration: string | undefined;

  constructor(migration: string | undefined, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(migration === undefined ? `state migrations failed: ${reason}` : `state migration ${migration} failed: ${reason}`, { cause });
    this.migration = migration;
  }
}
