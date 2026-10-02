// Five-field cron expressions for `WorkflowPort.cron` on the in-process scheduler (B 2). Evaluated in
// UTC, like pg-boss's default. Fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or
// JAN-DEC), day of week (0-7 or SUN-SAT, 0 and 7 are Sunday). Each field takes `*`, a value, a range
// `a-b`, a step `*/n` or `a-b/n` or `a/n`, or a comma list of those. The macros @yearly, @annually,
// @monthly, @weekly, @daily, @midnight, and @hourly expand to their usual five fields. When both day
// fields are restricted (neither starts with `*`), a day matches either one, as in Vixie cron.

export class CronExpressionError extends Error {
  constructor(
    readonly expression: string,
    reason: string,
  ) {
    super(`invalid cron expression ${JSON.stringify(expression)}: ${reason}`);
    this.name = 'CronExpressionError';
  }
}

export interface CronSchedule {
  readonly expression: string;
  /** The first matching minute strictly after `after`, at second 0. */
  next(after: Date): Date;
}

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** Offset added to a name's index (months are 1-based). */
  readonly nameBase?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { label: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

/** How far ahead `next` looks before deciding an expression never fires (covers 29 February). */
const HORIZON_YEARS = 9;

export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronExpressionError(expression, `expected 5 fields, got ${parts.length}`);
  }
  const [minute, hour, dom, month, dow] = FIELDS.map((spec, i) => parseField(expression, parts[i] ?? '', spec)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (dow.delete(7)) {
    dow.add(0);
  }
  const domRestricted = !(parts[2] ?? '').startsWith('*');
  const dowRestricted = !(parts[4] ?? '').startsWith('*');

  const dayMatches = (t: Date): boolean => {
    const d = dom.has(t.getUTCDate());
    const w = dow.has(t.getUTCDay());
    return domRestricted && dowRestricted ? d || w : d && w;
  };

  const schedule: CronSchedule = {
    expression,
    next(after) {
      const t = new Date(after.getTime());
      t.setUTCSeconds(0, 0);
      t.setUTCMinutes(t.getUTCMinutes() + 1);
      const limit = after.getUTCFullYear() + HORIZON_YEARS;
      while (t.getUTCFullYear() <= limit) {
        if (!month.has(t.getUTCMonth() + 1)) {
          t.setUTCMonth(t.getUTCMonth() + 1, 1);
          t.setUTCHours(0, 0, 0, 0);
          continue;
        }
        if (!dayMatches(t)) {
          t.setUTCDate(t.getUTCDate() + 1);
          t.setUTCHours(0, 0, 0, 0);
          continue;
        }
        if (!hour.has(t.getUTCHours())) {
          t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
          continue;
        }
        if (!minute.has(t.getUTCMinutes())) {
          t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
          continue;
        }
        return t;
      }
      throw new CronExpressionError(expression, `never fires within ${HORIZON_YEARS} years`);
    },
  };
  // Reject expressions that can never fire (for example `0 0 31 2 *`) when they are declared.
  schedule.next(new Date(Date.UTC(2000, 0, 1)));
  return schedule;
}

function parseField(expression: string, field: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  if (field === '') {
    throw new CronExpressionError(expression, `empty ${spec.label} field`);
  }
  for (const item of field.split(',')) {
    const [range = '', stepText, extra] = item.split('/');
    if (extra !== undefined) {
      throw new CronExpressionError(expression, `bad ${spec.label} item ${JSON.stringify(item)}`);
    }
    const step = stepText === undefined ? 1 : parseNumber(expression, stepText, spec, 1, spec.max);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes('-')) {
      const [a = '', b = '', more] = range.split('-');
      if (more !== undefined) {
        throw new CronExpressionError(expression, `bad ${spec.label} range ${JSON.stringify(range)}`);
      }
      lo = parseValue(expression, a, spec);
      hi = parseValue(expression, b, spec);
      if (lo > hi) {
        throw new CronExpressionError(expression, `${spec.label} range ${JSON.stringify(range)} runs backwards`);
      }
    } else {
      lo = parseValue(expression, range, spec);
      hi = stepText === undefined ? lo : spec.max;
    }
    for (let v = lo; v <= hi; v += step) {
      out.add(v);
    }
  }
  return out;
}

function parseValue(expression: string, text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) {
    return named + (spec.nameBase ?? 0);
  }
  return parseNumber(expression, text, spec, spec.min, spec.max);
}

function parseNumber(expression: string, text: string, spec: FieldSpec, min: number, max: number): number {
  if (!/^\d+$/.test(text)) {
    throw new CronExpressionError(expression, `bad ${spec.label} value ${JSON.stringify(text)}`);
  }
  const n = Number(text);
  if (n < min || n > max) {
    throw new CronExpressionError(expression, `${spec.label} value ${n} outside ${min}-${max}`);
  }
  return n;
}
