/** What a reserved route shows (`/runs`, `/runs/:id`, #348) until its page exists. */

import type { PageProps } from '../routes.ts';

export function NotBuiltPage(_props: PageProps) {
  return <p>This page is not built yet.</p>;
}
