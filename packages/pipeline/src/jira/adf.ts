// Minimal Atlassian Document Format (ADF) builders for ticket descriptions (main 9.1).
// Only what the description needs: doc, paragraph, text, with `strong` and `link` marks.

export type AdfMark = { type: 'strong' } | { type: 'link'; attrs: { href: string } };

export type AdfText = {
  type: 'text';
  text: string;
  marks?: AdfMark[];
};

export type AdfParagraph = {
  type: 'paragraph';
  content: AdfText[];
};

export type AdfDoc = {
  type: 'doc';
  version: 1;
  content: AdfParagraph[];
};

export function text(value: string, ...marks: AdfMark[]): AdfText {
  return marks.length === 0 ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

export const strong: AdfMark = { type: 'strong' };

export function link(href: string): AdfMark {
  return { type: 'link', attrs: { href } };
}

/** ADF forbids empty text nodes, so empty ones are dropped. */
export function paragraph(...nodes: AdfText[]): AdfParagraph {
  return { type: 'paragraph', content: nodes.filter((n) => n.text !== '') };
}

/** A paragraph shaped `Label: value`, with the label in bold. */
export function labeled(label: string, value: string): AdfParagraph {
  return paragraph(text(`${label}: `, strong), text(value));
}

/** A paragraph shaped `Label: <link>` where the link text is the URL itself. */
export function labeledLink(label: string, href: string): AdfParagraph {
  return paragraph(text(`${label}: `, strong), text(href, link(href)));
}

export function doc(...content: AdfParagraph[]): AdfDoc {
  return { type: 'doc', version: 1, content };
}

/**
 * A minimal shape check, not a full ADF validator: a version 1 doc whose content is non-empty
 * paragraphs of non-empty text nodes carrying only `strong` or `link` marks (links need an http(s) href).
 * Returns the problems found; an empty array means the doc passes.
 */
export function checkAdf(value: unknown): string[] {
  const problems: string[] = [];
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(value)) return ['doc must be an object'];
  if (value['type'] !== 'doc') problems.push('root type must be "doc"');
  if (value['version'] !== 1) problems.push('root version must be 1');
  const content = value['content'];
  if (!Array.isArray(content) || content.length === 0) return [...problems, 'doc.content must be a non-empty array'];
  content.forEach((p: unknown, i) => {
    if (!isRecord(p) || p['type'] !== 'paragraph') return void problems.push(`content[${i}] must be a paragraph`);
    const nodes = p['content'];
    if (!Array.isArray(nodes) || nodes.length === 0) return void problems.push(`content[${i}] must have text`);
    nodes.forEach((n: unknown, j) => {
      const at = `content[${i}].content[${j}]`;
      if (!isRecord(n) || n['type'] !== 'text') return void problems.push(`${at} must be a text node`);
      if (typeof n['text'] !== 'string' || n['text'] === '') problems.push(`${at}.text must be a non-empty string`);
      const marks = n['marks'];
      if (marks === undefined) return;
      if (!Array.isArray(marks)) return void problems.push(`${at}.marks must be an array`);
      for (const m of marks as unknown[]) {
        if (!isRecord(m)) problems.push(`${at} has a malformed mark`);
        else if (m['type'] === 'strong') continue;
        else if (m['type'] === 'link') {
          const attrs = m['attrs'];
          const href = isRecord(attrs) ? attrs['href'] : undefined;
          if (typeof href !== 'string' || !/^https?:\/\//.test(href)) problems.push(`${at} link needs an http(s) href`);
        } else problems.push(`${at} has unsupported mark ${String(m['type'])}`);
      }
    });
  });
  return problems;
}
