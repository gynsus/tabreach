import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectChrome } from './chrome.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabreach-chrome-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeChromeApp(name: string, plist: string | null): string {
  const app = join(dir, name);
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'Google Chrome'), '');
  if (plist !== null) writeFileSync(join(app, 'Contents', 'Info.plist'), plist);
  return app;
}

const xmlPlist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Google Chrome</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>`;

describe('detectChrome', () => {
  it('finds the first installed location and reads its version', async () => {
    const missing = join(dir, 'Nowhere', 'Google Chrome.app');
    const app = fakeChromeApp('Google Chrome.app', xmlPlist('154.0.8037.57'));
    await expect(detectChrome([missing, app])).resolves.toEqual({
      installed: true,
      path: app,
      version: '154.0.8037.57',
    });
  });

  it('reports Chrome as missing when no location has the executable', async () => {
    await expect(detectChrome([join(dir, 'Google Chrome.app')])).resolves.toEqual({
      installed: false,
      path: null,
      version: null,
    });
  });

  it('keeps Chrome installed with an unknown version when the plist is unreadable', async () => {
    const app = fakeChromeApp('Google Chrome.app', null);
    await expect(detectChrome([app])).resolves.toMatchObject({ installed: true, version: null });
  });
});

describe('sweepStaleProfiles', () => {
  it('removes only leftover launch-check profiles', async () => {
    const { sweepStaleProfiles } = await import('./launch-check.js');
    mkdirSync(join(dir, 'tabreach-launch-check-abc'));
    mkdirSync(join(dir, 'unrelated'));
    expect(await sweepStaleProfiles(dir)).toBe(1);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir)).toEqual(['unrelated']);
  });
});
