// 0008: one GitHub account, one chat user (main 11.2). A unique index on `(workspace_id,
// github_user_id)` backs `linkIdentity`'s refusal of a second holder. A database that already holds
// two rows for one account keeps the most recently updated one and drops the rest (their sealed
// tokens go with them; those users link again), so the index can be built.

import { sql, type Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';

export const name = '0008-linked-identity-unique-account';

export async function up(db: Kysely<unknown>, _dialect: StateDialect): Promise<void> {
  await sql`
    delete from linked_identities
    where exists (
      select 1 from linked_identities other
      where other.workspace_id = linked_identities.workspace_id
        and other.github_user_id = linked_identities.github_user_id
        and (
          other.updated_at > linked_identities.updated_at
          or (other.updated_at = linked_identities.updated_at and (other.chat > linked_identities.chat or (other.chat = linked_identities.chat and other.chat_user_id > linked_identities.chat_user_id)))
        )
    )
  `.execute(db);
  await db.schema.createIndex('linked_identities_workspace_id_github_user_id_key').on('linked_identities').columns(['workspace_id', 'github_user_id']).unique().execute();
}
