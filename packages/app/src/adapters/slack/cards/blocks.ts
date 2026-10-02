// Block Kit building blocks (main 8.2, 20.1). Pure: no I/O, no SDK. Slack limits are enforced here so
// a card that would be rejected by Slack fails in a unit test instead.

export const MAX_BUTTON_VALUE = 2000;
export const MAX_ACTION_ID = 255;
export const MAX_BUTTON_TEXT = 75;

export interface PlainText {
  type: 'plain_text';
  text: string;
}

export interface Mrkdwn {
  type: 'mrkdwn';
  text: string;
}

export interface SectionBlock {
  type: 'section';
  text: Mrkdwn;
}

export interface ContextBlock {
  type: 'context';
  elements: Mrkdwn[];
}

export interface ButtonElement {
  type: 'button';
  style?: 'primary' | 'danger';
  text: PlainText;
  action_id: string;
  value: string;
  url?: string;
}

export interface ActionsBlock {
  type: 'actions';
  block_id: string;
  elements: ButtonElement[];
}

export type SlackBlock = SectionBlock | ContextBlock | ActionsBlock;

/** A message payload: `text` is the notification and accessibility fallback. */
export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export interface ButtonSpec {
  label: string;
  actionId: string;
  /** The incident id. */
  value: string;
  style?: 'primary' | 'danger';
  url?: string;
}

/** Escapes the three characters Slack treats as control characters in mrkdwn text. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mention(userId: string): string {
  return `<@${userId}>`;
}

export function section(text: string): SectionBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

export function context(text: string): ContextBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function button(spec: ButtonSpec): ButtonElement {
  if (spec.value.length === 0 || spec.value.length > MAX_BUTTON_VALUE) {
    throw new RangeError(`button value must be 1 to ${MAX_BUTTON_VALUE} characters`);
  }
  if (spec.actionId.length === 0 || spec.actionId.length > MAX_ACTION_ID) {
    throw new RangeError(`action_id must be 1 to ${MAX_ACTION_ID} characters`);
  }
  return {
    type: 'button',
    ...(spec.style === undefined ? {} : { style: spec.style }),
    text: { type: 'plain_text', text: truncate(spec.label, MAX_BUTTON_TEXT) },
    action_id: spec.actionId,
    value: spec.value,
    ...(spec.url === undefined ? {} : { url: spec.url }),
  };
}

export function actions(blockId: string, buttons: ButtonSpec[]): ActionsBlock {
  if (buttons.length === 0 || buttons.length > 25) throw new RangeError('an actions block holds 1 to 25 buttons');
  const ids = new Set(buttons.map((b) => b.actionId));
  if (ids.size !== buttons.length) throw new RangeError('action_id must be unique within an actions block');
  return { type: 'actions', block_id: blockId, elements: buttons.map(button) };
}
