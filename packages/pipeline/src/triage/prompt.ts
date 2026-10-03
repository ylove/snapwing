// Loads prompts/triage.xml (main 8.1): the scout and triage system prompts.

import { readFile } from 'node:fs/promises';
import { withInstructions, type WorkspaceInstructions } from '../config/instructions.ts';

const PROMPT_URL = new URL('../prompts/triage.xml', import.meta.url);

export interface TriagePrompts {
  scoutSystem: string;
  triageSystem: string;
}

export function parseTriagePrompts(xml: string): TriagePrompts {
  const scoutSystem = /<scout-system>([\s\S]*?)<\/scout-system>/.exec(xml)?.[1]?.trim();
  const triageSystem = /<triage-system>([\s\S]*?)<\/triage-system>/.exec(xml)?.[1]?.trim();
  if (scoutSystem === undefined || triageSystem === undefined) {
    throw new Error('prompts/triage.xml needs <scout-system> and <triage-system>');
  }
  return { scoutSystem: scoutSystem.replace(/\s+/g, ' '), triageSystem: triageSystem.replace(/\s+/g, ' ') };
}

/**
 * The triage system prompt with the workspace instructions block (A 6.3) after it: the one place the
 * block enters triage. Without instructions it is `triageSystem` unchanged.
 */
export function triageSystemPrompt(prompts: TriagePrompts, instructions: WorkspaceInstructions | undefined): string {
  return withInstructions(prompts.triageSystem, instructions);
}

let cache: Promise<TriagePrompts> | undefined;

export function loadTriagePrompts(): Promise<TriagePrompts> {
  cache ??= readFile(PROMPT_URL, 'utf8').then(parseTriagePrompts);
  return cache;
}

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
