import Papa from 'papaparse';
import { RpcError, type ImportField } from '@tabreach/protocol';

export interface ParsedCsv {
  headers: string[];
  /** Non-blank data rows; `line` is the 1-based record number as a spreadsheet shows it (header = 1). */
  rows: { cells: string[]; line: number }[];
  delimiter: string;
}

/** Parses CSV text (any common delimiter, BOM tolerated). The first row is the header. */
export function parseCsv(text: string): ParsedCsv {
  // Blank rows are dropped below rather than by the parser so reported row numbers stay correct.
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: false });
  // An unclosed quote swallows every following line into one cell; importing that would silently
  // lose rows, so it is a file error. (A single-column file only yields an undetectable-delimiter
  // warning, which is fine.)
  const quote = result.errors.find((e) => e.type === 'Quotes');
  if (quote) {
    throw RpcError.validation({ csv: 'csv.unclosedQuote' }, `row ${(quote.row ?? 0) + 1}`);
  }
  if (result.data.length === 0) throw RpcError.validation({ csv: 'csv.unreadable' });
  const [header, ...rows] = result.data;
  if (!header || header.every((h) => !h.trim())) throw RpcError.validation({ csv: 'csv.noHeader' });
  return {
    headers: header.map((h) => h.trim()),
    rows: rows
      .map((r, i) => ({ cells: header.map((_, c) => (r[c] ?? '').trim()), line: i + 2 }))
      .filter((r) => r.cells.some((c) => c !== '')),
    delimiter: result.meta.delimiter,
  };
}

/** Header aliases (English and Russian) -> import field. Keys are compared after `headerKey`. */
const ALIASES: Record<string, ImportField> = {};
const alias = (field: ImportField, ...names: string[]) => {
  for (const n of names) ALIASES[headerKey(n)] = field;
};
alias(
  'company.name',
  'company',
  'company name',
  'company_name',
  'organization',
  'organisation',
  'account',
  'компания',
  'название компании',
  'организация',
);
alias(
  'company.website',
  'website',
  'site',
  'domain',
  'company website',
  'company_website',
  'company domain',
  'company_domain',
  'url',
  'сайт',
  'домен',
  'веб-сайт',
);
alias('company.country', 'country', 'company country', 'company_country', 'страна');
alias('company.city', 'city', 'company city', 'company_city', 'город');
alias('company.timezone', 'company timezone', 'company_timezone', 'часовой пояс компании');
alias('company.tags', 'company tags', 'company_tags', 'теги компании');
alias('contact.firstName', 'first name', 'first_name', 'firstname', 'given name', 'имя');
alias('contact.lastName', 'last name', 'last_name', 'lastname', 'surname', 'family name', 'фамилия');
alias(
  'contact.fullName',
  'full name',
  'full_name',
  'name',
  'contact',
  'contact name',
  'person',
  'фио',
  'полное имя',
  'контакт',
);
alias('contact.email', 'email', 'e-mail', 'email address', 'mail', 'почта', 'электронная почта', 'емейл');
alias('contact.jobTitle', 'title', 'job title', 'job_title', 'position', 'role', 'должность', 'позиция');
alias(
  'contact.linkedinUrl',
  'linkedin',
  'linkedin url',
  'linkedin_url',
  'linkedin profile',
  'профиль linkedin',
  'линкедин',
);
alias('contact.timezone', 'timezone', 'time zone', 'time_zone', 'tz', 'часовой пояс');
alias('contact.tags', 'tags', 'contact tags', 'contact_tags', 'теги', 'метки');

/** Lowercase, letters/digits only (Unicode-aware), so `E-mail`, `e_mail` and `EMAIL` compare equal. */
export function headerKey(header: string): string {
  return header.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export const CUSTOM_PREFIX = { contact: 'contact:', company: 'company:' } as const;

export function suggestMapping(headers: readonly string[]): ImportField[] {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const lower = h.toLowerCase();
    if (lower.startsWith(CUSTOM_PREFIX.contact)) return 'contact.custom';
    if (lower.startsWith(CUSTOM_PREFIX.company)) return 'company.custom';
    const field = ALIASES[headerKey(h)];
    // Each standard field is suggested once; later duplicates are ignored rather than overwritten.
    if (!field || used.has(field)) return 'ignore';
    used.add(field);
    return field;
  });
}

/** Custom field key for a mapped column: the header without an export prefix. */
export function customKey(header: string): string {
  const cleaned = unescapeCell(header.trim());
  const lower = cleaned.toLowerCase();
  for (const prefix of Object.values(CUSTOM_PREFIX)) {
    if (lower.startsWith(prefix)) return cleaned.slice(prefix.length).trim();
  }
  return cleaned;
}

/** Undo `safeCell` (`'=SUM` -> `=SUM`) so exported files re-import unchanged. */
export function unescapeCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Prevents spreadsheet formula injection when exported cells are opened in Excel/Numbers. */
export function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  // Headers too: custom field names come from imported headers and could carry a formula.
  return Papa.unparse(
    { fields: headers.map(safeCell), data: rows.map((r) => r.map(safeCell)) },
    { newline: '\n' },
  );
}
