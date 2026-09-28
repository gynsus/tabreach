import type { RpcError } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServices } from '../app-handlers.js';
import { ctx, testServices } from '../prospects/test-helpers.js';
import { detectKind } from './suppression-service.js';

let env: Awaited<ReturnType<typeof testServices>>;
let s: AppServices;
beforeEach(async () => {
  env = await testServices();
  s = env.services;
});
afterEach(() => env.close());

describe('suppressions', () => {
  it('normalizes values per kind and is idempotent', () => {
    const a = s.suppressions.add('email', ' Jane@Acme.com ', ctx());
    const b = s.suppressions.add('email', 'jane@acme.com', ctx());
    expect(b.id).toBe(a.id);
    s.suppressions.add('domain', 'https://www.Acme.com/', ctx());
    s.suppressions.add('profile_url', 'https://uk.linkedin.com/in/Jane/', ctx());
    expect(s.suppressions.list({ limit: 10, offset: 0 }).items.map((x) => [x.kind, x.value])).toEqual([
      ['profile_url', 'https://uk.linkedin.com/in/Jane/'],
      ['domain', 'acme.com'],
      ['email', 'Jane@Acme.com'],
    ]);
  });

  it('suppresses a company by id, keeping its name for display', () => {
    const co = s.prospects.createCompany({ name: 'Acme' }, ctx());
    expect(s.suppressions.add('company', co.id, ctx())).toMatchObject({ kind: 'company', value: 'Acme' });
  });

  it('rejects values that are invalid for their kind', () => {
    try {
      s.suppressions.add('email', 'nope', ctx());
      throw new Error('expected failure');
    } catch (e) {
      expect((e as RpcError).problem.fields).toEqual({ value: 'suppression.invalid.email' });
    }
  });

  it('imports the first CSV column, detecting kinds and skipping a header', () => {
    s.suppressions.add('email', 'old@x.com', ctx());
    const report = s.suppressions.importCsv(
      'value,note\nold@x.com,a\nnew@x.com,b\nexample.org,c\nhttps://linkedin.com/in/bob,d\n!!!,e\n',
      ctx(),
    );
    expect(report).toEqual({ added: 3, alreadyPresent: 1, invalid: 1 });
  });

  it('removes entries and audits both directions', () => {
    const x = s.suppressions.add('domain', 'acme.com', ctx());
    expect(s.suppressions.remove(x.id, ctx())).toBe(true);
    expect(s.suppressions.remove(x.id, ctx())).toBe(false);
    expect(
      s.audit.list({ objectType: 'suppression', objectId: x.id, limit: 5 }).map((e) => e.actionType),
    ).toEqual(['suppression.removed', 'suppression.added']);
  });

  it('detects kinds', () => {
    expect(detectKind('a@b.com')).toBe('email');
    expect(detectKind('linkedin.com/in/x')).toBe('profile_url');
    expect(detectKind('acme.com')).toBe('domain');
  });
});

describe('suppression regressions (phase 1.5)', () => {
  it('imports a bare site URL as a domain, not a profile', () => {
    expect(detectKind('https://acme.com')).toBe('domain');
    expect(detectKind('https://acme.com/')).toBe('domain');
    expect(detectKind('https://facebook.com/profile.php?id=1')).toBe('profile_url');
    s.suppressions.importCsv('https://Acme.com/\n', ctx());
    expect(s.suppressions.list({ limit: 5, offset: 0 }).items).toMatchObject([
      { kind: 'domain', value: 'acme.com' },
    ]);
  });

  it('finds entries case-insensitively in Cyrillic', () => {
    s.suppressions.add('domain', 'Пример.рф', ctx());
    expect(s.suppressions.list({ search: 'ПРИМЕР', limit: 5, offset: 0 }).total).toBe(1);
  });
});
