// src/util/github-text.ts: someone else's words in what the App writes on GitHub (#306): a review body or
// check run summary built from the review agent's reasons, a pull request body from the fixer's summary.
// Both agents read text the fixer controls, so what they write is untrusted. GitHub renders it as
// Markdown, where it could mention people or teams (`@name`), cross-reference issues (`#12`, which leaves
// a note on them), embed images or links (`![..](..)`, `[..](..)`), or carry HTML. `githubText` makes it
// plain text that renders as written:
//
//   - control, invisible, and bidirectional formatting characters are removed; with `multiline`
//     newlines stay, otherwise every line break becomes a space;
//   - `\`, `[` and `]` are backslash-escaped, so no link or image forms;
//   - `&`, `<` and `>` become entities, so no HTML or entity forms;
//   - a zero-width space (`&#8203;`) follows each `@` before a name character and each `#` before a
//     digit, so nothing is mentioned or cross-referenced.
//
// `githubCode` is for text inside a code span, where GitHub decodes no entity and forms no mention or
// link: it only drops backticks, line breaks, and the characters above.

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function githubText(text: string, options: { multiline?: boolean } = {}): string {
  const flat = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(INVISIBLE, '');
  const lines = options.multiline === true ? flat : flat.replace(/\n+/g, ' ');
  return lines
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // One pass, so the entity it inserts after an `@` is never read as a `#` before a digit.
    .replace(/@(?=[A-Za-z0-9])|#(?=\d)/g, (c) => `${c}&#8203;`);
}

export function githubCode(text: string): string {
  return text.replace(INVISIBLE, '').replace(/[`\n\t]/g, ' ').trim();
}
