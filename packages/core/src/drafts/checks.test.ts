import { describe, expect, it } from 'vitest';
import { allPassed, runDraftChecks, type DraftCheckInput } from './checks.js';
import { cleanDraftBody, cleanSubject } from './draft-writer.js';

const base: DraftCheckInput = {
  origin: 'ai',
  subject: 'Your new Berlin office',
  body: 'Hello Ann,\n\nCongratulations on opening the Berlin office in March 2026. Could we talk next week?\n\nBest,\nBob',
  signature: 'Best,\nBob',
  target: 'ann@acme.test',
  currentTarget: 'ann@acme.test',
  maxLength: 1_500,
  forbiddenPhrases: [],
  allowedLinkDomains: [],
  sources: [
    'Ann',
    'Lee',
    'Acme Robotics',
    'In March 2026 we opened our new Berlin office',
    'Ask for a call next week.',
  ],
};
const check = (input: Partial<DraftCheckInput>, key: string) =>
  runDraftChecks({ ...base, ...input }).find((c) => c.key === key);

describe('draft checks', () => {
  it('a draft built from its sources passes every check', () => {
    expect(allPassed(runDraftChecks(base))).toBe(true);
  });

  it('grounding: a number or a name the sources do not have fails, and is named', () => {
    const body = base.body.replace('Could we', 'With your 500 employees and the Munich team, could we');
    expect(check({ body }, 'grounding')).toEqual({ key: 'grounding', passed: false, detail: '500, Munich' });
  });

  it('grounding: numbers match across spacing, Russian word forms match, sentence starts are not names', () => {
    const r = check(
      {
        subject: null,
        body: 'Здравствуйте, Анна! Видел, что вы открыли офис в Москве. Ваш пакет от 1 490 000 ₽ выглядит интересно.\n\nBest,\nBob',
        sources: ['Анна', 'Открыли новый офис в Москва-Сити', 'Разработка MVP от 1490000 ₽'],
      },
      'grounding',
    );
    expect(r?.passed).toBe(true);
    expect(
      check({ body: 'Hello Ann, I think I can help. XYZ rocks.\n\nBest,\nBob' }, 'grounding'),
    ).toMatchObject({
      passed: false,
      detail: 'XYZ',
    });
  });

  it('links: only allowed domains, emails included; the signature is exempt', () => {
    const body =
      'Hello Ann, see https://evil.test/x or write to boss@evil.test, or visit acme.test/about.\n\nBest,\nBob';
    expect(check({ body, allowedLinkDomains: ['acme.test'] }, 'links')).toEqual({
      key: 'links',
      passed: false,
      detail: 'https://evil.test/x, boss@evil.test',
    });
    const signed = 'Hello Ann, a short note about the Berlin office.\n\nBob · https://bob.test';
    expect(check({ body: signed, signature: 'Bob · https://bob.test' }, 'links')?.passed).toBe(true);
  });

  it('length, forbidden phrases, signature and target', () => {
    expect(check({ maxLength: 100 }, 'length')).toMatchObject({ passed: false, detail: '107/100' });
    expect(check({ forbiddenPhrases: ['next  WEEK', 'guarantee'] }, 'forbidden_phrases')).toEqual({
      key: 'forbidden_phrases',
      passed: false,
      detail: 'next  WEEK',
    });
    expect(check({ body: 'Hello Ann, the Berlin office looks great.' }, 'signature')?.passed).toBe(false);
    expect(check({ currentTarget: 'ann@new.test' }, 'target')).toMatchObject({
      passed: false,
      detail: 'ann@new.test',
    });
    expect(allPassed([])).toBe(false);
  });

  it('grounding checks a hyphenated compound by its capitalised parts', () => {
    const body = 'Здравствуйте, Анна! Про ваше ИИ-направление и Berlin-офис.\n\nBest,\nBob';
    expect(check({ subject: null, body, sources: ['ИИ', 'Berlin', 'Анна'] }, 'grounding')?.passed).toBe(true);
    // The sources' compounds count by their parts too (live check: "B2B-рассылок" in the instructions).
    expect(
      check(
        {
          subject: null,
          body: 'Здравствуйте, Анна! Про B2B-продажи.\n\nBest,\nBob',
          sources: ['Анна', 'B2B-рассылки'],
        },
        'grounding',
      )?.passed,
    ).toBe(true);
    expect(check({ subject: null, body, sources: ['ИИ', 'Анна'] }, 'grounding')).toMatchObject({
      passed: false,
      detail: 'Berlin-офис',
    });
  });
});

describe('grounding after audit 4.5', () => {
  it('names at a sentence start, in brackets or quotes are checked; ordinary openers are not', () => {
    const body =
      'Hi Bob. Microsoft told us about Acme (Google) and "Oracle" too: Amazon agreed.\n\nBest,\nBob';
    expect(check({ subject: null, body, sources: ['Acme', 'Bob'] }, 'grounding')).toMatchObject({
      passed: false,
      detail: 'Microsoft, Google, Oracle, Amazon',
    });
    const plain =
      'Здравствуйте, Анна! Посмотрели ваш сайт. Отдельно отмечу работу с ИИ. Подскажите удобное время.\n\nBest,\nBob';
    expect(check({ subject: null, body: plain, sources: ['Анна', 'ИИ'] }, 'grounding')?.passed).toBe(true);
  });

  it('links: any TLD, bare hosts included', () => {
    for (const link of ['bit.ly/x', 'example.xyz', 'offer.shop/deal', 'пример.рф'])
      expect(
        check({ body: `Hello Ann, see ${link} for the Berlin office.\n\nBest,\nBob` }, 'links')?.passed,
      ).toBe(false);
    expect(
      check({ body: 'Hello Ann, т.е. 2.5 раза лучше, e.g. the Berlin office.\n\nBest,\nBob' }, 'links')
        ?.passed,
    ).toBe(true);
  });
});

describe('cleaning what the model wrote (live check, DeepSeek)', () => {
  it('removes fact refs and a closing line that repeats the start of the signature', () => {
    const body = 'Анна, здравствуйте!\n\nВы развиваете ИИ (F15) и RAG-базу [F13, F3].\n\nС уважением';
    expect(cleanDraftBody(body, 'С уважением,\nКоманда TabReach')).toBe(
      'Анна, здравствуйте!\n\nВы развиваете ИИ и RAG-базу.',
    );
    expect(cleanDraftBody('Hi Ann,\nThanks.\nBest regards', 'Bob')).toBe('Hi Ann,\nThanks.\nBest regards');
    expect(cleanSubject('Your Berlin office (F1)')).toBe('Your Berlin office');
  });
});
