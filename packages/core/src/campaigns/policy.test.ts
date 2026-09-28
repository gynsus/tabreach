import { describe, expect, it } from 'vitest';
import { domainAndParents } from './policy.js';

describe('domainAndParents', () => {
  it('lists the domain and its parents, not the bare TLD', () => {
    expect(domainAndParents('mail.eu.acme.com')).toEqual(['mail.eu.acme.com', 'eu.acme.com', 'acme.com']);
    expect(domainAndParents('acme.com')).toEqual(['acme.com']);
    expect(domainAndParents(null)).toEqual([]);
  });
});
