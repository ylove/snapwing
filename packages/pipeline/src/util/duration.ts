/** Thrown by parseDuration for anything that is not a supported ISO 8601 duration. */
export class InvalidDurationError extends Error {
  readonly input: string;

  constructor(input: string, reason = 'not a valid ISO 8601 duration') {
    super(`Invalid duration ${JSON.stringify(input)}: ${reason}`);
    this.name = 'InvalidDurationError';
    this.input = input;
  }
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Parses P[nD][T[nH][nM][nS]] (fractional seconds allowed) to milliseconds. */
export function parseDuration(input: string): number {
  const m = DURATION.exec(input);
  if (!m) throw new InvalidDurationError(input);
  const [, d, h, min, s] = m;
  if (d === undefined && h === undefined && min === undefined && s === undefined) {
    throw new InvalidDurationError(input, 'no components');
  }
  if (input.endsWith('T')) throw new InvalidDurationError(input, 'empty time part');
  return Math.round(
    Number(d ?? 0) * MS_PER_DAY +
      Number(h ?? 0) * MS_PER_HOUR +
      Number(min ?? 0) * MS_PER_MINUTE +
      Number(s ?? 0) * MS_PER_SECOND,
  );
}

/** Formats milliseconds as an ISO 8601 duration; parseDuration(formatDuration(ms)) === ms. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new InvalidDurationError(String(ms), 'must be a non-negative finite number');
  }
  const total = Math.round(ms);
  const days = Math.floor(total / MS_PER_DAY);
  let rest = total % MS_PER_DAY;
  const hours = Math.floor(rest / MS_PER_HOUR);
  rest %= MS_PER_HOUR;
  const minutes = Math.floor(rest / MS_PER_MINUTE);
  rest %= MS_PER_MINUTE;
  const seconds = rest / MS_PER_SECOND;
  let out = 'P';
  if (days) out += `${days}D`;
  let time = '';
  if (hours) time += `${hours}H`;
  if (minutes) time += `${minutes}M`;
  if (seconds) time += `${seconds}S`;
  if (time) out += `T${time}`;
  return out === 'P' ? 'PT0S' : out;
}
