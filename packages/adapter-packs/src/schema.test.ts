import { describe, expect, it } from 'vitest';
import { adapterPackSchema, parseAdapterPack } from './schema.js';

const connectable = {
  id: 'linkedin.profile.connectable',
  url: ['https://www.linkedin.com/in/*'],
  requires: [
    { role: 'heading', level: 1 },
    { role: 'button', nameAny: ['Connect', 'Установить контакт'] },
  ],
  forbids: [{ textAny: ['security verification', 'unusual activity'] }],
};

describe('adapter pack schema', () => {
  it('accepts the documented page-state example', () => {
    const pack = parseAdapterPack({
      id: 'linkedin',
      version: '1.0.0',
      channel: 'linkedin',
      states: [connectable],
    });
    expect(pack.states[0]?.requires).toHaveLength(2);
  });

  it('defaults forbids to an empty list', () => {
    const { forbids, ...withoutForbids } = connectable;
    expect(forbids).toHaveLength(1);
    const pack = parseAdapterPack({
      id: 'linkedin',
      version: '1.0.0',
      channel: 'linkedin',
      states: [withoutForbids],
    });
    expect(pack.states[0]?.forbids).toEqual([]);
  });

  it('rejects a state without positive conditions (allowlist rule)', () => {
    const result = adapterPackSchema.safeParse({
      id: 'linkedin',
      version: '1.0.0',
      channel: 'linkedin',
      states: [{ ...connectable, requires: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate state ids, non-https URLs and unknown keys', () => {
    const base = { id: 'linkedin', version: '1.0.0', channel: 'linkedin' };
    expect(adapterPackSchema.safeParse({ ...base, states: [connectable, connectable] }).success).toBe(false);
    expect(
      adapterPackSchema.safeParse({
        ...base,
        states: [{ ...connectable, url: ['http://www.linkedin.com/in/*'] }],
      }).success,
    ).toBe(false);
    expect(
      adapterPackSchema.safeParse({ ...base, states: [{ ...connectable, script: 'click()' }] }).success,
    ).toBe(false);
  });

  it('requires a semantic version', () => {
    expect(
      adapterPackSchema.safeParse({
        id: 'linkedin',
        version: 'latest',
        channel: 'linkedin',
        states: [connectable],
      }).success,
    ).toBe(false);
  });

  it('an action refers only to states of its pack', () => {
    const base = {
      id: 'forms',
      version: '1.0.0',
      channel: 'web_form',
      states: [
        { id: 'site.form', url: ['https://x.test/*'], requires: [{ role: 'form' }] },
        { id: 'site.thanks', url: ['https://x.test/*'], requires: [{ textAny: ['Thank you'] }] },
      ],
    };
    const action = {
      id: 'site.send',
      from: ['site.form'],
      fill: [{ control: { role: 'textbox', nameAny: ['Message'] }, param: 'body' }],
      commit: { role: 'button', nameAny: ['Send'] },
      success: ['site.thanks'],
    };
    expect(parseAdapterPack({ ...base, actions: [action] }).actions[0]?.rejected).toEqual([]);
    expect(() => parseAdapterPack({ ...base, actions: [{ ...action, success: ['site.nowhere'] }] })).toThrow(
      /Unknown state site.nowhere/,
    );
    expect(() => parseAdapterPack({ ...base, actions: [action, action] })).toThrow(/Duplicate action/);
  });
});
