import type { DatabaseSync } from 'node:sqlite';
import { RpcError } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServices } from '../app-handlers.js';
import { ctx, testServices } from './test-helpers.js';

let env: Awaited<ReturnType<typeof testServices>>;
let s: AppServices;
let db: DatabaseSync;
beforeEach(async () => {
  env = await testServices();
  s = env.services;
  db = env.db;
});
afterEach(() => env.close());

const fieldsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RpcError) return e.problem.fields;
    throw e;
  }
  throw new Error('expected a validation error');
};

describe('companies', () => {
  it('creates a company with a normalized domain and tags, and audits it', () => {
    const c = s.prospects.createCompany(
      { name: 'Acme', website: 'https://www.Acme.com/about', tags: ['SaaS', 'saas'] },
      ctx(),
    );
    expect(c).toMatchObject({
      name: 'Acme',
      domain: 'acme.com',
      websiteUrl: 'https://www.Acme.com/about',
      tags: ['SaaS'],
    });
    expect(
      s.audit.list({ objectType: 'company', objectId: c.id, limit: 10 }).map((e) => e.actionType),
    ).toEqual(['company.created']);
  });

  it('rejects an invalid website and a domain another company owns', () => {
    expect(fieldsOf(() => s.prospects.createCompany({ name: 'X', website: 'not a site' }, ctx()))).toEqual({
      website: 'website.invalid',
    });
    s.prospects.createCompany({ name: 'Acme', website: 'acme.com' }, ctx());
    expect(
      fieldsOf(() => s.prospects.createCompany({ name: 'Acme 2', website: 'www.acme.com' }, ctx())),
    ).toEqual({
      website: 'website.duplicate',
    });
  });

  it('records only fields that actually changed', () => {
    const c = s.prospects.createCompany({ name: 'Acme', city: 'Berlin' }, ctx());
    s.prospects.updateCompany({ id: c.id, city: 'Berlin' }, ctx());
    s.prospects.updateCompany({ id: c.id, city: 'Munich', tags: ['b2b'] }, ctx());
    const events = s.audit.list({ objectType: 'company', objectId: c.id, limit: 10 });
    expect(events.map((e) => [e.actionType, e.payload.fields])).toEqual([
      ['company.updated', ['city', 'tags']],
      ['company.created', undefined],
    ]);
  });

  it('searches case-insensitively in Cyrillic and Latin', () => {
    s.prospects.createCompany({ name: 'Ромашка', website: 'romashka.ru' }, ctx());
    s.prospects.createCompany({ name: 'Acme GmbH' }, ctx());
    expect(
      s.prospects.listCompanies({ search: 'РОМАШ', limit: 10, offset: 0 }).items.map((c) => c.name),
    ).toEqual(['Ромашка']);
    expect(s.prospects.listCompanies({ search: 'acme', limit: 10, offset: 0 }).total).toBe(1);
    expect(s.prospects.listCompanies({ search: '100%_', limit: 10, offset: 0 }).total).toBe(0);
  });
});

describe('contacts', () => {
  it('creates a contact linked to a company with LinkedIn and email', () => {
    const co = s.prospects.createCompany({ name: 'Acme' }, ctx());
    const c = s.prospects.createContact(
      {
        companyId: co.id,
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'Jane@Acme.com',
        linkedinUrl: 'linkedin.com/in/jane-doe/',
      },
      ctx(),
    );
    expect(c).toMatchObject({ companyName: 'Acme', displayName: 'Jane Doe', email: 'Jane@Acme.com' });
    expect(c.linkedinUrl).toBe('linkedin.com/in/jane-doe/');
    expect(s.prospects.getCompany(co.id).contacts).toHaveLength(1);
  });

  it('enforces one contact per email and per LinkedIn profile', () => {
    s.prospects.createContact(
      { fullName: 'Jane', email: 'jane@acme.com', linkedinUrl: 'https://linkedin.com/in/jane' },
      ctx(),
    );
    expect(
      fieldsOf(() => s.prospects.createContact({ fullName: 'J2', email: 'JANE@acme.com' }, ctx())),
    ).toEqual({
      email: 'email.duplicate',
    });
    expect(
      fieldsOf(() =>
        s.prospects.createContact({ fullName: 'J3', linkedinUrl: 'https://uk.linkedin.com/in/Jane/' }, ctx()),
      ),
    ).toEqual({ linkedinUrl: 'linkedin.duplicate' });
  });

  it('requires some identity and valid values', () => {
    expect(fieldsOf(() => s.prospects.createContact({ jobTitle: 'CEO' }, ctx()))).toEqual({
      fullName: 'contact.identityRequired',
    });
    expect(fieldsOf(() => s.prospects.createContact({ email: 'nope' }, ctx()))).toEqual({
      email: 'email.invalid',
    });
    expect(fieldsOf(() => s.prospects.createContact({ linkedinUrl: 'https://x.com/jane' }, ctx()))).toEqual({
      linkedinUrl: 'linkedin.invalid',
    });
  });

  it('updates, clears and re-keys a contact', () => {
    const c = s.prospects.createContact({ fullName: 'Иван Петров', email: 'ivan@x.ru' }, ctx());
    const updated = s.prospects.updateContact(
      { id: c.id, email: null, jobTitle: 'CTO', tags: ['лид'] },
      ctx(),
    );
    expect(updated).toMatchObject({ email: null, jobTitle: 'CTO', tags: ['лид'] });
    expect(s.prospects.listContacts({ search: 'иван', limit: 10, offset: 0 }).total).toBe(1);
  });
});

describe('audit trail', () => {
  it('is append-only at the database level', () => {
    s.prospects.createCompany({ name: 'Acme' }, ctx());
    expect(() => db.exec(`UPDATE action_events SET status = 'failed'`)).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM action_events')).toThrow(/append-only/);
  });

  it('redacts secret-looking payload keys', () => {
    const id = s.audit.record({
      actorType: 'system',
      actionType: 'test',
      payload: { nested: { apiKey: 'sk-1', ok: 1 } },
      correlationId: ctx().correlationId,
    });
    const [event] = s.audit.list({ limit: 1 });
    expect(event?.id).toBe(id);
    expect(event?.payload).toEqual({ nested: { apiKey: '[REDACTED]', ok: 1 } });
  });
});
