import { bundledPack } from '@tabreach/adapter-packs';
import { describe, expect, it } from 'vitest';
import { mapForm } from './forms.js';

const knowledge = bundledPack('web-form')!.forms!;
const field = (over: Partial<Parameters<typeof mapForm>[0]['fields'][number]>) => ({
  ref: 0,
  tag: 'input',
  type: 'text',
  name: '',
  id: '',
  autocomplete: '',
  placeholder: '',
  label: '',
  required: false,
  visible: true,
  ...over,
});
const map = (fields: ReturnType<typeof field>[]) =>
  mapForm(
    { visible: true, role: '', fields: fields.map((f, ref) => ({ ...f, ref })) },
    { name: 'Anna Test', email: 'a@s.test', company: 'S', message: 'Hi' },
    knowledge,
  ).map((f) => [f.label, f.meaning, f.value]);

describe('form field meanings (Phase 6)', () => {
  it('prefers the specific meaning and reads names, ids and autocomplete', () => {
    expect(
      map([
        field({ label: 'Company name' }),
        field({ label: 'First name' }),
        field({ label: 'Last name' }),
        field({ label: 'Confirm e-mail' }),
        field({ label: 'Org', autocomplete: 'organization' }),
        field({ tag: 'textarea', type: 'textarea', label: 'Anything else?' }),
      ]),
    ).toEqual([
      ['Company name', 'company', 'S'],
      ['First name', 'firstName', 'Anna'],
      ['Last name', 'lastName', 'Test'],
      ['Confirm e-mail', 'email', 'a@s.test'],
      ['Org', 'company', 'S'],
      ['Anything else?', 'message', 'Hi'],
    ]);
  });

  it('a lone first-name field takes the whole name; hidden fields are never filled', () => {
    expect(map([field({ label: 'Имя' }), field({ label: 'Website', visible: false })])).toEqual([
      ['Имя', 'name', 'Anna Test'],
    ]);
    expect(map([field({ name: 'fullname', label: 'Who are you' })])).toEqual([
      ['Who are you', 'name', 'Anna Test'],
    ]);
  });

  it('check boxes are consent or nothing, and never get a value; selects are left alone', () => {
    expect(
      map([
        field({ type: 'checkbox', label: 'I accept the privacy policy' }),
        field({ type: 'checkbox', label: 'Urgent' }),
        field({ tag: 'select', type: 'select', label: 'Topic' }),
      ]),
    ).toEqual([
      ['I accept the privacy policy', 'consent', null],
      ['Urgent', null, null],
      ['Topic', null, null],
    ]);
  });
});
