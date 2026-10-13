/**
 * The queue page, a placeholder until the queue page task (#356) replaces this file. It already loads
 * the viewer's queue through the API client, so the sign-in and role paths show here first.
 */

import { ApiView, useApiCall } from '../components/api-state.tsx';
import type { PageProps } from '../routes.ts';

export function QueuePage(_props: PageProps) {
  const state = useApiCall((api) => api.queue());
  return (
    <ApiView state={state}>
      {(queue) => (
        <>
          <p>
            The full queue page is not built yet. Until it is, the queue and its buttons are on Snapwing&apos;s Home tab in
            Slack and on the queue card in Teams.
          </p>
          <h2>{queue.title}</h2>
          <ul>
            {queue.sections.map((section) => (
              <li key={section.id}>
                {section.title}: {section.items.length === 0 ? section.empty : String(section.items.length)}
              </li>
            ))}
          </ul>
        </>
      )}
    </ApiView>
  );
}
