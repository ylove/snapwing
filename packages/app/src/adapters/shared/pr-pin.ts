// The PR and commit a PR button acts on (`PrPin`, #264, main 11.2, 11.3), as each platform's button
// carries it: in a Slack button's `value` after the incident id, and in a Teams action's `data` as
// strings. The tap hands it back (`ChatTap.pin`), and the PR actions refuse it when either no longer
// matches. Pure: the card builders and the tap parsers share it.

import type { PrPin } from '@snapwing/pipeline/contracts/adapters.ts';

const SEP = ':';
const SHA = /^[0-9a-f]{7,64}$/i;

function pinOf(prNumber: string | undefined, sha: string | undefined): PrPin | undefined {
  if (prNumber === undefined || sha === undefined || !/^[1-9][0-9]{0,9}$/.test(prNumber) || !SHA.test(sha)) return undefined;
  return { prNumber: Number(prNumber), sha };
}

/** A Slack button `value`: the incident id, then `:<prNumber>:<sha>` when the button is pinned. */
export function pinnedValue(incidentId: string, pin?: PrPin): string {
  return pin === undefined ? incidentId : [incidentId, String(pin.prNumber), pin.sha].join(SEP);
}

/** A Slack button `value` read back: the incident id, and the pin when it carries a well-formed one. */
export function parsePinnedValue(value: string): { incidentId: string; pin?: PrPin } {
  const [incidentId = '', prNumber, sha, ...rest] = value.split(SEP);
  const pin = rest.length === 0 ? pinOf(prNumber, sha) : undefined;
  return pin === undefined ? { incidentId } : { incidentId, pin };
}

/** The Teams action `data` keys a pinned button adds: `prNumber` and `sha`, as strings. */
export function pinData(pin?: PrPin): Record<string, string> {
  return pin === undefined ? {} : { prNumber: String(pin.prNumber), sha: pin.sha };
}

/** The pin in a Teams action's `data`, when it carries a well-formed one. */
export function pinFromData(data: Readonly<Record<string, string>>): PrPin | undefined {
  return pinOf(data['prNumber'], data['sha']);
}
