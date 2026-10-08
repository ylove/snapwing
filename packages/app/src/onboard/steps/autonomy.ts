// Onboarding step `autonomy` (main 22.2, main 4.6): how much Snapwing does on its own. It describes
// the four levels in one line each, defaults everything to Ask (level 1), recommends promoting later,
// and records who chose what and when. A different level for one product is offered only when the
// installer asks for it.
//
// Reads (interview state): `surfaces.surfaces` (the confirmed products, for per-product levels).
// Its own data, which the map-writing step turns into `<autonomy>`:
//   default:    0 | 1 | 2 | 3
//   changedBy, changedAt
//   overrides:  [{ kind: 'surface', ref, level, changedBy, changedAt }]   only where it differs from the default

import type { JsonObject, JsonValue } from '../interview/state.ts';
import type { OnboardStep, StepContext, StepOutcome } from '../interview/step.ts';

export const DEFAULT_LEVEL = 1;

interface LevelInfo {
  readonly id: '0' | '1' | '2' | '3';
  readonly label: string;
}

const LEVELS: readonly LevelInfo[] = [
  { id: '0', label: 'Note only (level 0): files the ticket and tells the right person; never starts a fix' },
  { id: '1', label: 'Ask (level 1): files the ticket, and starts a fix only when an engineer taps Fix it; people merge' },
  { id: '2', label: 'Fix now (level 2): starts the fix as soon as the ticket exists, with a Stop button; people merge' },
  { id: '3', label: 'Autopilot (level 3): fixes and merges by itself when review, tests, and the risk limits all pass' },
];

const ASK_DETAIL =
  'Ask is where to start: Snapwing files and routes every bug, and your engineers decide which ones get a fix. Once the tickets and diagnoses look right, move a product up to Fix now. Autopilot suits only products with strong tests and little that can go wrong.';

const SAVED_LEVEL = (v: JsonValue | undefined): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined);

function surfaceIds(ctx: StepContext): { id: string; label: string }[] {
  const raw = ctx.data('surfaces')?.['surfaces'];
  if (!Array.isArray(raw)) return [];
  const out: { id: string; label: string }[] = [];
  for (const s of raw) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) continue;
    const { id, label } = s as { [k: string]: JsonValue };
    if (typeof id === 'string') out.push({ id, label: typeof label === 'string' ? label : id });
  }
  return out;
}

const levelName = (level: number): string => (LEVELS[level]?.label ?? '').split(' (')[0] ?? '';

/** Who is choosing: the process's own idea of the user, offered as the answer to press Enter for. */
function guessWho(ctx: StepContext): string | undefined {
  for (const key of ['GIT_AUTHOR_EMAIL', 'USER', 'LOGNAME', 'USERNAME']) {
    const v = ctx.env[key]?.trim();
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

export const autonomyStep: OnboardStep = {
  id: 'autonomy',
  number: 8,
  title: 'Choose how much Snapwing does on its own',
  needs: ['surfaces'],
  async run(ctx): Promise<StepOutcome> {
    const { io } = ctx;
    const products = surfaceIds(ctx);

    const saved = ctx.data('autonomy');
    const savedDefault = SAVED_LEVEL(saved?.['default']);
    if (saved !== undefined && savedDefault !== undefined && typeof saved['changedBy'] === 'string') {
      const overrides = Array.isArray(saved['overrides']) ? saved['overrides'].length : 0;
      io.say(`Saved: ${levelName(savedDefault)} for everything${overrides === 0 ? '' : `, with ${overrides} product${overrides === 1 ? '' : 's'} set differently`}, chosen by ${saved['changedBy']}.`);
      const keep = await io.choose({
        id: 'keep',
        text: 'Keep these levels?',
        choices: [
          { id: 'keep', label: 'Keep them' },
          { id: 'change', label: 'Choose again' },
        ],
        default: 'keep',
      });
      if (keep === 'keep') return { status: 'done', data: saved };
    }

    io.say('How much should Snapwing do on its own? There are four levels:');
    for (const l of LEVELS) io.say(`  ${l.label}`);
    io.say(ASK_DETAIL);

    const chosen = Number(
      await io.choose({
        id: 'level',
        text: 'Which level should every product start at?',
        choices: LEVELS.map((l) => ({ id: l.id, label: l.label.split(':')[0] ?? l.label })),
        default: String(DEFAULT_LEVEL),
        why: 'Sets <autonomy default="..."/> in the workspace map. You can change any product later with snapwing map set-level.',
      }),
    );
    if (chosen !== DEFAULT_LEVEL) io.say(`${levelName(chosen)} is your choice. Starting at Ask and moving up once you trust the results is the safer way.`);
    if (chosen === 3) io.say('Autopilot merges code without a person reading it. If anything is off it drops back to Fix now, but keep it to products with strong tests.');

    const levels = new Map<string, number>();
    if (products.length > 1) {
      const differ = await io.choose({
        id: 'differ',
        text: 'Should any product be different?',
        choices: [
          { id: 'no', label: `No, all at ${levelName(chosen)}` },
          { id: 'yes', label: 'Yes, set some products separately' },
        ],
        default: 'no',
      });
      if (differ === 'yes') {
        for (const p of products) {
          const level = Number(
            await io.choose({
              id: `level-${p.id}`,
              text: `Level for ${p.label}?`,
              choices: LEVELS.map((l) => ({ id: l.id, label: l.label.split(':')[0] ?? l.label })),
              default: String(chosen),
            }),
          );
          if (level !== chosen) levels.set(p.id, level);
        }
      }
    }

    const guess = guessWho(ctx);
    const who = await io.ask({
      id: 'by',
      text: `Your name or email, to record who chose these levels${guess === undefined ? '' : `. Press Enter for ${guess}`}:`,
      ...(guess === undefined ? {} : { default: guess }),
      why: 'Saved as changedBy and changedAt on the autonomy setting in the workspace map, so anyone can see who changed a level and when.',
    });
    const at = ctx.now().toISOString();
    const overrides: JsonObject[] = [...levels].map(([ref, level]) => ({ kind: 'surface', ref, level, changedBy: who, changedAt: at }));
    io.say(`Recorded: ${levelName(chosen)} for everything${overrides.length === 0 ? '' : `, ${overrides.length} product${overrides.length === 1 ? '' : 's'} set differently`}.`);
    return { status: 'done', data: { default: chosen, changedBy: who, changedAt: at, overrides } };
  },
};
