/**
 * How pages reach the API client and show a call's state (#348). The shell provides the client
 * through `ApiContext`, so a page test renders the page inside a provider with a fake client.
 * `ApiView` shows a loading line, the worded problem (`describeProblem`), or the page's content.
 */

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useId, useState } from 'preact/hooks';
import { createApiClient, describeProblem, type ApiClient, type ApiProblem, type ApiResult } from '../api.ts';

export const ApiContext = createContext<ApiClient>(createApiClient());

export function useApi(): ApiClient {
  return useContext(ApiContext);
}

export type CallState<T> = { readonly status: 'loading' } | { readonly status: 'done'; readonly result: ApiResult<T> };

/** Runs `call` on mount and again when a value in `deps` changes; a stale answer is dropped. */
export function useApiCall<T>(call: (api: ApiClient) => Promise<ApiResult<T>>, deps: readonly unknown[] = []): CallState<T> {
  const api = useApi();
  const [state, setState] = useState<CallState<T>>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    void call(api).then((result) => {
      if (current) setState({ status: 'done', result });
    });
    return () => {
      current = false;
    };
    // `call` is a fresh closure each render; `deps` names what it reads.
  }, [api, ...deps]);
  return state;
}

export function ProblemNotice({ problem }: { readonly problem: ApiProblem }) {
  const id = useId();
  const text = describeProblem(problem);
  return (
    <section class="problem" data-problem={problem.kind} aria-labelledby={id}>
      <h2 id={id}>{text.title}</h2>
      {text.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </section>
  );
}

export interface ApiViewProps<T> {
  readonly state: CallState<T>;
  readonly children: (value: T) => ComponentChildren;
}

/** A polite live region, so the answer or the problem is announced when it replaces the loading line. */
export function ApiView<T>({ state, children }: ApiViewProps<T>) {
  const loading = state.status === 'loading';
  return (
    <div aria-live="polite" aria-busy={loading}>
      {loading ? <p class="muted">Loading...</p> : state.result.ok ? children(state.result.value) : <ProblemNotice problem={state.result.problem} />}
    </div>
  );
}
