/** Characters mail clients leave behind when turning HTML into text (image placeholders, zero-width). */
const JUNK = /[\uFFFC\u200B-\u200D\u2060\uFEFF]/g;

/** Lines that introduce a quoted earlier message, in the clients people actually use. */
const QUOTE_INTRO: RegExp[] = [
  // Apple Mail, Gmail, Thunderbird (English), possibly already quoted: "On 28 Sep 2026, at 9:10 PM, Ann <a@b> wrote:"
  /^(>\s*)?On\b.{0,200}\bwrote:\s*$/i,
  // Gmail in Russian: "пн, 28 сент. 2026 г. в 21:10, Ann <a@b>:" and "... пишет:"
  /^(>\s*)?.{0,120}\d{4}.{0,80}<[^<>\s]+@[^<>\s]+>:\s*$/,
  // `\b` is ASCII-only in JavaScript, so Cyrillic words are delimited by whitespace.
  /^(>\s*)?.{0,200}\s(пишет|написал|написала):\s*$/i,
  // Outlook
  /^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение|Forwarded message)\s*-{2,}\s*$/i,
];
const OUTLOOK_FROM = /^(From|От):\s.+$/;
const OUTLOOK_SENT = /^(Sent|Date|Отправлено|Дата):\s.+$/;

/**
 * The part of a reply the person actually wrote: without the quoted earlier message, the
 * standard `-- ` signature block and invisible leftovers. Falls back to the whole text when
 * nothing would remain (a reply that is only a quote is still shown).
 */
export function replyText(text: string): string {
  const lines = text.replace(JUNK, '').replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  const isIntro = (l: string) => QUOTE_INTRO.some((re) => re.test(l));
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    const next = (lines[i + 1] ?? '').trim();
    // Gmail wraps a long introduction over two lines ("On …, Ann <\na@b> wrote:").
    if (isIntro(line) || (!isIntro(next) && next !== '' && isIntro(`${line} ${next}`))) {
      end = i;
      break;
    }
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_SENT.test(l.trim()))) {
      end = i;
      break;
    }
    if (line === '--') {
      end = i;
      break;
    }
  }
  let kept = lines.slice(0, end);
  // A trailing block of quoted lines ("> ...") without an introduction.
  let cut = kept.length;
  while (cut > 0 && /^\s*(>.*)?$/.test(kept[cut - 1] ?? '')) cut--;
  if (kept.slice(cut).some((l) => l.trim().startsWith('>'))) kept = kept.slice(0, cut);
  const result = kept
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return result || text.replace(JUNK, '').trim();
}
