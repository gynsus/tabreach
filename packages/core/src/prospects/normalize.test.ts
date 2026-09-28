import { describe, expect, it } from 'vitest';
import { nameKey, normalizeDomain, normalizeEmail, normalizeProfileUrl, splitTags } from './normalize.js';

describe('normalizeEmail', () => {
  it('lowercases and trims valid addresses', () => {
    expect(normalizeEmail('  Anna.Smith@Example.COM ')).toBe('anna.smith@example.com');
  });
  it('keeps dots and plus tags: they can be different mailboxes', () => {
    expect(normalizeEmail('a.b+sales@example.com')).toBe('a.b+sales@example.com');
  });
  it('accepts internationalized domains and stores them in punycode', () => {
    expect(normalizeEmail('Info@Пример.РФ')).toBe('info@xn--e1afmkfd.xn--p1ai');
    expect(normalizeEmail('p4@ромашка.com')).toBe('p4@xn--80aa3agjl3d.com');
  });
  it('rejects non-ASCII mailboxes (they need SMTPUTF8)', () => {
    expect(normalizeEmail('иван@пример.рф')).toBeNull();
  });
  it('rejects invalid input', () => {
    for (const v of [
      '',
      '   ',
      'not-an-email',
      'a@',
      '@b.com',
      'a@localhost',
      'a b@c.com',
      null,
      undefined,
    ]) {
      expect(normalizeEmail(v)).toBeNull();
    }
  });
});

describe('normalizeDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    ['WWW.Example.com', 'example.com'],
    ['https://www.example.com/about?x=1', 'example.com'],
    ['http://shop.example.co.uk:8080/', 'shop.example.co.uk'],
    ['example.com.', 'example.com'],
    ['anna@example.com', 'example.com'],
    ['пример.рф', 'xn--e1afmkfd.xn--p1ai'],
    ['https://пример.рф/контакты', 'xn--e1afmkfd.xn--p1ai'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it('rejects hosts that are not domains', () => {
    for (const v of ['', 'localhost', '192.168.0.1', 'not a domain', null]) {
      expect(normalizeDomain(v)).toBeNull();
    }
  });
});

describe('normalizeProfileUrl', () => {
  it('canonicalizes LinkedIn person profiles', () => {
    for (const v of [
      'https://www.linkedin.com/in/Jane-Doe/',
      'linkedin.com/in/jane-doe',
      'https://uk.linkedin.com/in/jane-doe?trk=abc#top',
      'http://linkedin.com/in/jane-doe/details/experience/',
    ]) {
      expect(normalizeProfileUrl(v)).toMatchObject({
        channel: 'linkedin',
        normalized: 'linkedin.com/in/jane-doe',
      });
    }
  });

  it('decodes percent-encoded slugs so both spellings match', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/%D0%B8%D0%B2%D0%B0%D0%BD')?.normalized).toBe(
      'linkedin.com/in/иван',
    );
    expect(normalizeProfileUrl('https://www.linkedin.com/in/иван')?.normalized).toBe('linkedin.com/in/иван');
  });

  it('rejects LinkedIn URLs that are not person profiles', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/company/acme')).toBeNull();
  });

  it('keeps other profile URLs as host + path and preserves the original', () => {
    expect(normalizeProfileUrl(' https://www.x.com/JaneDoe/?s=1 ')).toEqual({
      channel: 'other',
      normalized: 'x.com/JaneDoe',
      original: 'https://www.x.com/JaneDoe/?s=1',
    });
  });

  it('rejects non-web schemes', () => {
    expect(normalizeProfileUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeProfileUrl('ftp://example.com/x')).toBeNull();
  });
});

describe('nameKey and splitTags', () => {
  it('compares names ignoring case and spacing', () => {
    expect(nameKey('  ACME   Corp ')).toBe(nameKey('acme corp'));
  });
  it('splits tags on ; , | and removes duplicates', () => {
    expect(splitTags('SaaS; fintech,saas | Berlin ')).toEqual(['SaaS', 'fintech', 'Berlin']);
    expect(splitTags('')).toEqual([]);
  });
});
