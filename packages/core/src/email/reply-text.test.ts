import { describe, expect, it } from 'vitest';
import { replyText } from './reply-text.js';

describe('replyText', () => {
  it('Apple Mail: drops the image placeholder and the quoted message, keeps the signature', () => {
    const body = [
      'Любой текст',
      '',
      'С уважением,',
      'Петрова Анна',
      '',
      '',
      '\uFFFC',
      '',
      '',
      'Веб сайт: https://example.test',
      '',
      '> On 28 Sep 2026, at 9:10\u202fPM, Sender <sender@example.test> wrote:',
      '> ',
      '> Здравствуйте, Anna!',
      '> ',
      '> Спасибо!',
    ].join('\n');
    expect(replyText(body)).toBe(
      'Любой текст\n\nС уважением,\nПетрова Анна\n\nВеб сайт: https://example.test',
    );
  });

  it('Gmail in English, with the introduction wrapped over two lines', () => {
    const body =
      'Yes, let us talk.\n\nOn Mon, Sep 28, 2026 at 9:10 PM Sender <\nsender@example.test> wrote:\n\n> Hello\n';
    expect(replyText(body)).toBe('Yes, let us talk.');
  });

  it('Gmail in Russian and Outlook', () => {
    expect(
      replyText('Давайте.\n\nпн, 28 сент. 2026 г. в 21:10, Sender <sender@example.test>:\n\n> Привет'),
    ).toBe('Давайте.');
    expect(
      replyText(
        'Интересно.\n\nОт: Sender <sender@example.test>\nОтправлено: 28 сентября 2026 г. 21:10\nТема: Проверка',
      ),
    ).toBe('Интересно.');
    expect(replyText('Sure.\n\n-----Original Message-----\nFrom: x')).toBe('Sure.');
    expect(replyText('Хорошо.\n\n28.09.2026, 21:10, Иван Петров пишет:\n> Привет')).toBe('Хорошо.');
  });

  it('an introduction that starts with the date, with the signature below the quote', () => {
    const text = [
      'Sounds good, let us talk next week',
      '',
      'September 28, 2026 9:10 PM, "Ann Lee" <ann@example.test> wrote:',
      '',
      '> Hello!',
      '>',
      '> Earlier text.',
      '',
      'Bob Smith',
      'Telegram @bob',
    ].join('\n');
    expect(replyText(text)).toBe('Sounds good, let us talk next week');
    expect(replyText('I wrote: the 2026 plan is attached')).toBe('I wrote: the 2026 plan is attached');
  });

  it('drops a standard signature and a trailing quote without introduction', () => {
    expect(replyText('Ok\n-- \nAnn Lee\nCEO')).toBe('Ok');
    expect(replyText('Ok\n\n> earlier\n> text\n')).toBe('Ok');
  });

  it('keeps text that merely mentions "wrote:" or ">" inside, and falls back when only a quote remains', () => {
    expect(replyText('I wrote: see below\n2 > 1')).toBe('I wrote: see below\n2 > 1');
    expect(replyText('> only quoted')).toBe('> only quoted');
  });
});
