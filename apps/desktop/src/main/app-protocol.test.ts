import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, isAppPageUrl, resolveAppFile } from './app-protocol.js';

const root = '/App.app/Contents/Resources/app.asar/out/renderer';

describe('resolveAppFile', () => {
  it('serves the entry page and its assets', () => {
    expect(resolveAppFile(root, APP_ENTRY_URL)).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://tabreach/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://tabreach/assets/index-Ba2AZ1b-.js')).toBe(
      join(root, 'assets/index-Ba2AZ1b-.js'),
    );
  });

  it('ignores the query and hash', () => {
    expect(resolveAppFile(root, 'app://tabreach/index.html?x=1#/settings/general')).toBe(
      join(root, 'index.html'),
    );
  });

  it('never leaves the renderer build', () => {
    // The URL parser already clamps dot segments at the root.
    expect(resolveAppFile(root, 'app://tabreach/../main/index.js')).toBe(join(root, 'main/index.js'));
    expect(resolveAppFile(root, 'app://tabreach/%2e%2e/main/index.js')).toBe(join(root, 'main/index.js'));
    // An encoded slash survives the parser and is caught after decoding.
    expect(resolveAppFile(root, 'app://tabreach/assets/%2e%2e%2f%2e%2e%2fmain/core.js')).toBeNull();
    expect(resolveAppFile(root, 'app://tabreach/a%00b')).toBeNull();
    expect(resolveAppFile(root, 'app://tabreach/%E0%A4%A')).toBeNull();
  });

  it('answers only its own host and scheme', () => {
    expect(resolveAppFile(root, 'app://other/index.html')).toBeNull();
    expect(resolveAppFile(root, 'file:///etc/passwd')).toBeNull();
    expect(resolveAppFile(root, 'not a url')).toBeNull();
  });
});

describe('isAppPageUrl', () => {
  it('accepts the packaged renderer at any route', () => {
    expect(isAppPageUrl(APP_ENTRY_URL, null)).toBe(true);
    expect(isAppPageUrl('app://tabreach/index.html#/settings/general', null)).toBe(true);
  });

  it('rejects other pages', () => {
    expect(isAppPageUrl('app://other/index.html', null)).toBe(false);
    expect(
      isAppPageUrl(
        'file:///Applications/TabReach.app/Contents/Resources/app.asar/out/renderer/index.html',
        null,
      ),
    ).toBe(false);
    expect(isAppPageUrl('https://tabreach/index.html', null)).toBe(false);
    expect(isAppPageUrl('', null)).toBe(false);
  });

  it('accepts only the dev server in development', () => {
    expect(isAppPageUrl('http://localhost:5173/#/today', 'http://localhost:5173')).toBe(true);
    expect(isAppPageUrl(APP_ENTRY_URL, 'http://localhost:5173')).toBe(false);
  });
});
