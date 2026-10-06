import { CaptureView } from './capture-view.tsx';
import { sendScreenshot, type FlowDeps } from './flow.ts';

const start = (deps: FlowDeps) => sendScreenshot(deps);

export default function Command() {
  return <CaptureView start={start} />;
}
