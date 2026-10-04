import { CaptureView } from './capture-view.tsx';
import { sendSelection, type FlowDeps } from './flow.ts';

const start = (deps: FlowDeps) => sendSelection(deps);

export default function Command() {
  return <CaptureView start={start} />;
}
