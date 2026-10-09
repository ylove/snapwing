// Untrusted text on GitHub (#306): the review agent's reasons in a review body and check run summary.

import { describe, expect, it } from 'vitest';
import { reviewBody } from '../../src/review/job.ts';
import { githubCode, githubText } from '../../src/util/github-text.ts';

describe('githubText', () => {
  it('renders as written: no mention, cross-reference, link, image, HTML, or entity', () => {
    expect(githubText('cc @alice and @acme/security, see #12 and a@b.example')).toBe('cc @&#8203;alice and @&#8203;acme/security, see #&#8203;12 and a@&#8203;b.example');
    expect(githubText('![t](https://track.example/p.png) [docs](https://phish.example)')).toBe('!\\[t\\](https://track.example/p.png) \\[docs\\](https://phish.example)');
    expect(githubText('<img src=x onerror=alert(1)> &#64;bob \\[ok\\]')).toBe('&lt;img src=x onerror=alert(1)&gt; &amp;#&#8203;64;bob \\\\\\[ok\\\\\\]');
  });

  it('keeps one line unless asked, and drops control, invisible, and bidirectional characters', () => {
    expect(githubText('one\n# Heading\r\n- item\u0007\u202e\u200b\tend')).toBe('one # Heading - item end');
    expect(githubText('one\n\n# Heading', { multiline: true })).toBe('one\n\n# Heading');
  });

  it('githubCode keeps a path in its code span', () => {
    expect(githubCode('src/a`b.ts\n@x\u0000')).toBe('src/a b.ts @x');
  });
});

describe('reviewBody (#306)', () => {
  it('writes the agent reasons, notes, and paths so none mentions, links, or adds a line of its own', () => {
    const body = reviewBody(
      {
        verdict: 'request-changes',
        reasons: ['Ask @org/admins to merge this\n## Approved', 'See ![x](https://track.example/x.png)'],
        constraintViolations: [{ constraint: 'scope', file: 'src/`evil`\n.ts', note: 'touches <script> outside #3' }],
        regressionTest: { path: 'test/a`.ts' },
      },
      'a'.repeat(40),
    );
    expect(body.split('\n')).toEqual([
      '**Snapwing review agent: request-changes** (aaaaaaaaaaaa)',
      '',
      '- Ask @&#8203;org/admins to merge this ## Approved',
      '- See !\\[x\\](https://track.example/x.png)',
      '',
      'Constraint violations:',
      '- scope `src/ evil  .ts`: touches &lt;script&gt; outside #&#8203;3',
      '',
      'Regression test: `test/a .ts`',
    ]);
  });
});
