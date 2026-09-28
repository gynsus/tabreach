import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChromeInfo } from '@tabreach/protocol';

const execFileAsync = promisify(execFile);

/** Where Google Chrome is installed on macOS, system-wide first (docs/08-BROWSER-PROFILES.md). */
export function defaultChromeLocations(): string[] {
  return ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')];
}

export async function detectChrome(locations: string[] = defaultChromeLocations()): Promise<ChromeInfo> {
  for (const appPath of locations) {
    if (!existsSync(join(appPath, 'Contents', 'MacOS', 'Google Chrome'))) continue;
    return { installed: true, path: appPath, version: await readBundleVersion(appPath) };
  }
  return { installed: false, path: null, version: null };
}

/** Reads CFBundleShortVersionString; returns null rather than failing detection. */
export async function readBundleVersion(appPath: string): Promise<string | null> {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  try {
    const xml = await readFile(plistPath, 'utf8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    if (match?.[1]) return match[1];
  } catch {
    return null;
  }
  // Binary plist: let the system tool decode it.
  try {
    const { stdout } = await execFileAsync('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      plistPath,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
