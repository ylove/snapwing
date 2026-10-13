/**
 * The incident page, a placeholder until the incident timeline task (#358) replaces this file. The route
 * passes the incident's ref and, for a stored patch, `query.patch` (a SHA-256 in lowercase hex).
 */

import type { PageProps } from '../routes.ts';

export function IncidentPage({ params, query }: PageProps) {
  const patch = query['patch'];
  return (
    <>
      <p>
        The incident timeline is not built yet. In a terminal, <code>snapwing trace {params['ref']}</code> prints it.
      </p>
      {patch === undefined ? null : <p>Stored patch {patch}: the patch view is not built yet.</p>}
    </>
  );
}
