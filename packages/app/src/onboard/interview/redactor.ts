// Scrubs the secrets a run has seen from anything it saves or says (main 22.3, #274). A value is masked in its
// raw form, its JSON-escaped form (what a saved state document holds), and, for a multi-line value such as a
// PEM key, each of its lines on its own. The longest candidate goes first, so a value that contains another is
// masked whole.

import type { SecretValue } from './io.ts';

const MIN_REDACT_LENGTH = 6;
const MASK = '[secret]';

export class Redactor {
  readonly #values = new Set<string>();
  #ordered: string[] = [];

  /** Remembers a secret (and returns it). Values under six characters are too short to mask safely. */
  add(secret: SecretValue): SecretValue {
    this.addText(secret.reveal());
    return secret;
  }

  addText(text: string): void {
    const forms = [text, JSON.stringify(text).slice(1, -1)];
    for (const line of text.split(/\r\n|\r|\n/)) {
      const trimmed = line.trim();
      forms.push(trimmed, JSON.stringify(trimmed).slice(1, -1));
    }
    let added = false;
    for (const form of forms) {
      if (form.length >= MIN_REDACT_LENGTH && !this.#values.has(form)) {
        this.#values.add(form);
        added = true;
      }
    }
    if (added) this.#ordered = [...this.#values].sort((a, b) => b.length - a.length);
  }

  text(s: string): string {
    let out = s;
    for (const v of this.#ordered) out = out.split(v).join(MASK);
    return out;
  }

  record<T>(record: T): T {
    const json = JSON.stringify(record);
    const clean = this.text(json);
    return clean === json ? record : (JSON.parse(clean) as T);
  }
}
