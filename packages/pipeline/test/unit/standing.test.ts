// The standing-watch phrases (A 4.4), parsed once for Slack and Teams.

import { describe, expect, it } from 'vitest';
import { parseStandingWatch } from '../../src/signals/standing.ts';

describe('parseStandingWatch stop phrases', () => {
  it('reads "stop updating me (on X)" as a standing stop, anchored or not', () => {
    const stop = { action: 'unwatch', target: 'web', command: false };
    expect(parseStandingWatch('stop updating me on web')).toEqual(stop);
    expect(parseStandingWatch('Please stop updating me on web.')).toEqual(stop);
    expect(parseStandingWatch('can you stop updating me on web')).toEqual(stop);
    expect(parseStandingWatch('could you quit updating me about web?')).toEqual(stop);
  });

  it('keeps the earlier stop phrases', () => {
    expect(parseStandingWatch('stop keeping me posted on web')).toEqual({ action: 'unwatch', target: 'web', command: false });
    expect(parseStandingWatch('unsubscribe me from the website')).toEqual({ action: 'unwatch', target: 'the website', command: false });
    expect(parseStandingWatch('unwatch web')).toEqual({ action: 'unwatch', target: 'web', command: false });
  });

  it('leaves a bug report alone', () => {
    expect(parseStandingWatch('the app keeps updating metrics wrong')).toBeUndefined();
    expect(parseStandingWatch('stop updating methods are broken')).toBeUndefined();
  });
});
