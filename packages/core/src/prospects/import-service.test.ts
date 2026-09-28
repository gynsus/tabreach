import type { ImportField } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServices } from '../app-handlers.js';
import { ctx, testServices } from './test-helpers.js';

let env: Awaited<ReturnType<typeof testServices>>;
let s: AppServices;
beforeEach(async () => {
  env = await testServices();
  s = env.services;
});
afterEach(() => env.close());

const csv = [
  'Company,Website,First name,Last name,Email,LinkedIn,Tags,Industry',
  'Acme,https://www.acme.com,Jane,Doe,jane@acme.com,https://www.linkedin.com/in/jane-doe/,lead; saas,Software',
  'Acme,acme.com,John,Roe,john@acme.com,,lead,Software',
  'Ромашка,romashka.ru,Иван,Петров,IVAN@ROMASHKA.RU,,,Retail',
  'Globex,,,,,,,',
  '',
  ',,,,,,,Retail',
  'Bad Site,not a website,,,,,,',
  'Initech,initech.com,Peter,Gibbons,not-an-email,,,',
].join('\n');

function commit(text: string, onMatch: 'skip' | 'fill_empty' | 'overwrite' = 'fill_empty') {
  const preview = s.imports.preview(text);
  const mapping = preview.suggestedMapping.map((f, i) =>
    f === 'ignore' && preview.headers[i] === 'Industry' ? ('company.custom' as ImportField) : f,
  );
  return s.imports.commit(text, mapping, onMatch, ctx());
}

describe('import preview', () => {
  it('detects the delimiter, headers and a mapping for English and Russian headers', () => {
    const preview = s.imports.preview(
      '\uFEFFКомпания;Сайт;Имя;Фамилия;E-mail;Должность\nАльфа;alfa.ru;Анна;Иванова;anna@alfa.ru;CEO\n',
    );
    expect(preview.delimiter).toBe(';');
    expect(preview.rowCount).toBe(1);
    expect(preview.suggestedMapping).toEqual([
      'company.name',
      'company.website',
      'contact.firstName',
      'contact.lastName',
      'contact.email',
      'contact.jobTitle',
    ]);
  });
});

describe('import commit', () => {
  it('imports valid rows, reports invalid ones with spreadsheet row numbers', () => {
    const report = commit(csv);
    expect(report).toMatchObject({
      totalRows: 7,
      inserted: 4,
      invalid: 3,
      companiesCreated: 3,
      contactsCreated: 3,
    });
    // The blank line 6 is not a row; the numbers below are the lines a spreadsheet shows.
    expect(report.errors).toEqual([
      { row: 7, reason: 'row.empty' },
      { row: 8, reason: 'website.invalid' },
      { row: 9, reason: 'email.invalid' },
    ]);
    const acme = s.prospects.listCompanies({ search: 'acme', limit: 5, offset: 0 }).items[0];
    expect(acme).toMatchObject({
      domain: 'acme.com',
      contactCount: 2,
      customFields: { Industry: 'Software' },
    });
    const jane = s.prospects.listContacts({ search: 'jane', limit: 5, offset: 0 }).items[0];
    expect(jane).toMatchObject({
      tags: ['lead', 'saas'],
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
    });
  });

  it('is deterministic: importing the same file again changes nothing', () => {
    commit(csv);
    const counts = () => [
      s.prospects.listCompanies({ limit: 1, offset: 0 }).total,
      s.prospects.listContacts({ limit: 1, offset: 0 }).total,
    ];
    const before = counts();
    const again = commit(csv);
    expect(again).toMatchObject({ inserted: 0, updated: 0, skipped: 4, invalid: 3 });
    expect(counts()).toEqual(before);
  });

  it('fill_empty fills blanks only; overwrite replaces; skip leaves matches alone', () => {
    commit('Company,Website,Email,Title\nAcme,acme.com,jane@acme.com,\n');
    commit('Company,Website,Email,Title\nAcme,acme.com,jane@acme.com,CEO\n', 'skip');
    expect(s.prospects.listContacts({ limit: 5, offset: 0 }).items[0]?.jobTitle).toBeNull();

    commit('Company,Website,Email,Title\nAcme,acme.com,jane@acme.com,CEO\n', 'fill_empty');
    commit('Company,Website,Email,Title\nAcme,acme.com,jane@acme.com,CTO\n', 'fill_empty');
    expect(s.prospects.listContacts({ limit: 5, offset: 0 }).items[0]?.jobTitle).toBe('CEO');

    const r = commit('Company,Website,Email,Title\nAcme,acme.com,jane@acme.com,CTO\n', 'overwrite');
    expect(r.updated).toBe(1);
    expect(s.prospects.listContacts({ limit: 5, offset: 0 }).items[0]?.jobTitle).toBe('CTO');
  });

  it('keeps same-named companies on different domains apart', () => {
    commit('Company,Website\nAcme,acme.com\nAcme,acme.de\n');
    expect(s.prospects.listCompanies({ search: 'acme', limit: 5, offset: 0 }).total).toBe(2);
  });

  it('matches a contact by LinkedIn profile when the email is missing', () => {
    commit('Name,LinkedIn\nJane Doe,https://linkedin.com/in/jane-doe\n');
    const r = commit(
      'Name,LinkedIn,Email\nJane Doe,https://uk.linkedin.com/in/Jane-Doe/?trk=x,jane@acme.com\n',
    );
    expect(r).toMatchObject({ inserted: 0, updated: 1 });
    expect(s.prospects.listContacts({ limit: 5, offset: 0 })).toMatchObject({
      total: 1,
      items: [{ email: 'jane@acme.com' }],
    });
  });

  it('rolls back the whole import on an unexpected failure', () => {
    const before = s.prospects.listCompanies({ limit: 1, offset: 0 }).total;
    expect(() =>
      s.imports.commit('Company\nAcme\n', ['company.name', 'company.name'], 'fill_empty', ctx()),
    ).toThrow();
    expect(s.prospects.listCompanies({ limit: 1, offset: 0 }).total).toBe(before);
  });

  it('records one import event plus per-entity events', () => {
    const r = commit('Company,Email\nAcme,jane@acme.com\n');
    const [event] = s.audit.list({ objectType: 'import', objectId: r.importId, limit: 5 });
    expect(event).toMatchObject({
      actionType: 'import.committed',
      payload: { inserted: 1, onMatch: 'fill_empty' },
    });
    expect(s.audit.list({ objectType: 'contact', limit: 5 })[0]?.payload).toMatchObject({
      importId: r.importId,
    });
  });
});

describe('export', () => {
  it('round-trips: re-importing an export changes nothing', () => {
    commit(csv);
    s.prospects.createCompany({ name: '=HYPERLINK("x")', website: 'formula.example' }, ctx());
    const exported = s.exports.exportProspects(ctx());
    expect(exported.csv.startsWith('\uFEFF')).toBe(true);
    expect(exported.csv).toContain(`"'=HYPERLINK(""x"")"`);
    const preview = s.imports.preview(exported.csv);
    expect(preview.suggestedMapping).not.toContain('ignore');
    const report = s.imports.commit(exported.csv, preview.suggestedMapping, 'overwrite', ctx());
    expect(report).toMatchObject({ inserted: 0, updated: 0, invalid: 0 });
    expect(report.skipped).toBe(exported.rows);
  });
});
