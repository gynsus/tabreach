import { describe, expect, it } from 'vitest';
import { renderTemplate, unknownPlaceholders } from './template.js';

describe('templates', () => {
  it('fills fields and defaults', () => {
    expect(
      renderTemplate('Hi {{firstName}} from {{ companyName | your team }}', { firstName: 'Анна' }),
    ).toEqual({
      text: 'Hi Анна from your team',
      missing: [],
    });
  });

  it('reports missing values instead of rendering them empty', () => {
    expect(renderTemplate('Hi {{firstName}}, {{jobTitle}}', { firstName: '  ' }).missing).toEqual([
      'firstName',
      'jobTitle',
    ]);
  });

  it('finds unknown placeholders', () => {
    expect(unknownPlaceholders('{{firstName}} {{favouriteColour}} {{ nickname|x }}')).toEqual([
      'favouriteColour',
      'nickname',
    ]);
  });
});
