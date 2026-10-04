import { Action, ActionPanel, Icon, List, openExtensionPreferences, popToRoot, showHUD } from '@raycast/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { choose, createFlowDeps, failure, type ChooseStep, type FlowDeps, type Step } from './flow.ts';

/**
 * One view for both commands: sending (empty list), the lookup-first choices (a small List),
 * or an inline failure. A final outcome is a HUD and the window closes.
 */
export function CaptureView({ start }: { readonly start: (deps: FlowDeps) => Promise<Step> }) {
  const [step, setStep] = useState<Step | undefined>(undefined);
  const deps = useRef<FlowDeps | undefined>(undefined);

  const settle = useCallback(async (next: Step) => {
    if (next.kind === 'done') {
      await showHUD(next.hud);
      await popToRoot();
      return;
    }
    setStep(next);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        deps.current = createFlowDeps();
        await settle(await start(deps.current));
      } catch (cause) {
        await settle(failure(cause));
      }
    })();
  }, [start, settle]);

  const pick = async (current: ChooseStep, choiceId: string) => {
    if (deps.current === undefined) return;
    setStep(undefined);
    await settle(await choose(deps.current, current, choiceId));
  };

  if (step === undefined) return <List isLoading searchBarPlaceholder="Sending to Snapwing" />;

  if (step.kind === 'choose') {
    return (
      <List navigationTitle="Snapwing">
        <List.Section title={step.title}>
          {step.choices.map((c) => (
            <List.Item
              key={c.id}
              title={c.label}
              icon={Icon.ArrowRight}
              actions={
                <ActionPanel>
                  <Action title={c.label} onAction={() => void pick(step, c.id)} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      </List>
    );
  }

  const isAuth = step.kind === 'auth';
  return (
    <List>
      <List.EmptyView
        icon={isAuth ? Icon.Key : Icon.ExclamationMark}
        title={step.kind === 'done' ? step.hud : step.message}
        actions={
          <ActionPanel>
            {isAuth ? <Action title="Open Extension Preferences" onAction={openExtensionPreferences} /> : null}
          </ActionPanel>
        }
      />
    </List>
  );
}
