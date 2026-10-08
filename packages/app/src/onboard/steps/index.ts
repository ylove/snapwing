// The ordered step registry (main 22.2): the runtime, then the interview's steps, with Slack and
// Teams as two modules for the chat platform and the map written before the test drive. Each step
// lives in its own file and its issue replaces only that file. Order is the order a run asks in;
// every need names an earlier step (`validateRegistry`). A step's number, where one is shown
// (`snapwing onboard --status`), is its place in this list, counting the runtime as 0.

import type { OnboardStep } from '../interview/step.ts';
import { runtimeStep } from './runtime.ts';
import { slackStep } from './slack.ts';
import { teamsStep } from './teams.ts';
import { jiraStep } from './jira.ts';
import { githubStep } from './github.ts';
import { surfacesStep } from './surfaces.ts';
import { wordsStep } from './words.ts';
import { peopleStep } from './people.ts';
import { triggerStep } from './trigger.ts';
import { autonomyStep } from './autonomy.ts';
import { finishStep } from './finish.ts';
import { testDriveStep } from './test-drive.ts';

export const ONBOARD_STEPS: readonly OnboardStep[] = Object.freeze([
  runtimeStep,
  slackStep,
  teamsStep,
  jiraStep,
  githubStep,
  surfacesStep,
  wordsStep,
  peopleStep,
  triggerStep,
  autonomyStep,
  finishStep,
  testDriveStep,
]);
