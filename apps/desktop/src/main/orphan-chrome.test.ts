import { describe, expect, it } from 'vitest';
import { orphanChromePids } from './orphan-chrome';

describe('orphan Chrome detection', () => {
  it('finds only Chrome processes of our profiles folder', () => {
    const root = '/Users/me/Library/Application Support/TabReach/profiles';
    const ps = [
      '  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/TabReach/profiles/0199-a --remote-debugging-pipe',
      '  102 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer --user-data-dir=/Users/me/Library/Application Support/TabReach/profiles/0199-a',
      '  103 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '  104 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/TabReach/profiles-old/x',
      '  105 /bin/zsh',
    ].join('\n');
    expect(orphanChromePids(ps, `${root}/`)).toEqual([101, 102]);
  });
});
