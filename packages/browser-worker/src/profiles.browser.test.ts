import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { silentLogger, uuidv7, type SessionChanged } from '@tabreach/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';

// Real installed Google Chrome, headless, against the local fixture site (never a live site in CI).
let fixtures: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
});
afterAll(() => fixtures.close());

describe('browser profiles (Phase 5a)', () => {
  let root: string;
  let profiles: ProfileManager;
  const changes: SessionChanged[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-profiles-'));
    profiles = new ProfileManager({ root, headless: true, logger: silentLogger });
    profiles.notify = (c) => changes.push(c);
    changes.length = 0;
  });
  afterEach(async () => {
    await profiles.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  const open = (profileId: string, startUrl: string | null = null) =>
    profiles.open({ profileId, sessionId: uuidv7(), channel: 'chrome', startUrl });

  it('keeps a sign-in across closing and opening the profile again (the exit criterion)', async () => {
    const profileId = uuidv7();
    const first = uuidv7();
    await profiles.open({
      profileId,
      sessionId: first,
      channel: 'chrome',
      startUrl: `${fixtures.url}login/`,
    });
    // Standing in for the person signing in by hand in the visible window.
    const page = profiles.contextOf(first)!.pages()[0]!;
    await page.getByLabel('Username').fill('ann');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Signed in as ann' }).waitFor();
    await profiles.close(first);
    expect(changes).toEqual([{ sessionId: first, profileId, status: 'closed', currentUrl: null }]);

    const second = uuidv7();
    const reopened = await profiles.open({
      profileId,
      sessionId: second,
      channel: 'chrome',
      startUrl: `${fixtures.url}login/account.html`,
    });
    expect(reopened.chromeVersion).toMatch(/^\d+\./);
    await profiles
      .contextOf(second)!
      .pages()[0]!
      .getByRole('heading', { name: 'Signed in as ann' })
      .waitFor();
  });

  it('one browser per profile; health says busy while open; deletion needs it closed', async () => {
    const profileId = uuidv7();
    expect(await profiles.health(profileId)).toEqual({ status: 'healthy', detail: 'profile.new' });
    await open(profileId);
    await expect(open(profileId)).rejects.toMatchObject({ problem: { detail: 'profile.alreadyOpen' } });
    expect(await profiles.health(profileId)).toEqual({ status: 'busy', detail: 'profile.open' });
    await expect(profiles.delete(profileId)).rejects.toMatchObject({ problem: { detail: 'profile.open' } });
    expect(profiles.heartbeat()).toHaveLength(1);
    await profiles.closeAll();
    expect(await profiles.health(profileId)).toEqual({ status: 'healthy', detail: null });
    await profiles.delete(profileId);
    expect(existsSync(join(root, profileId))).toBe(false);
  });

  it('closing the last window ends the session; ids never leave the profiles folder', async () => {
    const profileId = uuidv7();
    const sessionId = uuidv7();
    await profiles.open({ profileId, sessionId, channel: 'chrome', startUrl: null });
    await profiles.contextOf(sessionId)!.pages()[0]!.close();
    await expect.poll(() => changes.map((c) => c.status)).toEqual(['closed']);
    expect(profiles.heartbeat()).toEqual([]);
    expect(() => profiles.dir('../../etc')).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'profile.invalidId' }) }),
    );
  });
});
