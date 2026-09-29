import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CSV_CHARS,
  uuidv7,
  type ImportField,
  type ImportPreview,
  type ImportReport,
  type OnMatch,
} from '@tabreach/protocol';
import { Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { translateKey } from '../../i18n';
import { Alert, Button, Modal, Select } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const FIELDS: ImportField[] = [
  'ignore',
  'company.name',
  'company.website',
  'company.country',
  'company.city',
  'company.tags',
  'company.custom',
  'contact.firstName',
  'contact.lastName',
  'contact.fullName',
  'contact.email',
  'contact.jobTitle',
  'contact.linkedinUrl',
  'contact.tags',
  'contact.custom',
];

/** `company.name` -> `import.fields.companyName` */
const fieldKey = (field: ImportField) =>
  field === 'ignore'
    ? 'import.fields.ignore'
    : `import.fields.${field.replace(/\.(\w)/, (_, c: string) => c.toUpperCase())}`;

const MATCH_OPTIONS: OnMatch[] = ['fill_empty', 'overwrite', 'skip'];

export function ImportButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Upload size={14} aria-hidden />
        {t('common.importCsv')}
      </Button>
      {open ? <ImportDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileId = useId();
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  const [onMatch, setOnMatch] = useState<OnMatch>('fill_empty');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Each chosen file gets a token (to drop a slow preview of an earlier file) and an idempotency key
  // (so a retried commit of the same file imports it once).
  const fileToken = useRef(0);
  const [idempotencyKey, setIdempotencyKey] = useState(() => uuidv7());
  const read = useMutation({
    mutationFn: async ({ text, token }: { text: string; token: number }) => ({
      token,
      preview: await call('imports.prospects.preview', { csv: text }),
    }),
    onSuccess: ({ token, preview: p }) => {
      if (token !== fileToken.current) return;
      setPreview(p);
      setMapping(p.suggestedMapping);
    },
  });
  const commit = useMutation({
    mutationFn: () =>
      call('imports.prospects.commit', { csv: csv ?? '', mapping, onMatch }, { idempotencyKey }),
    onSuccess: async (r) => {
      setReport(r);
      await invalidateEntities(qc, ['company', 'contact', 'activity']);
    },
  });

  const reset = () => {
    setCsv(null);
    setPreview(null);
    setReport(null);
    setFileError(null);
    read.reset();
    commit.reset();
  };

  const onFile = async (file: File | undefined) => {
    reset();
    const token = ++fileToken.current;
    setIdempotencyKey(uuidv7());
    if (!file) return;
    const text = await file.text();
    if (token !== fileToken.current) return;
    if (text.length > MAX_CSV_CHARS) {
      setFileError(t('import.fileTooLarge'));
      return;
    }
    setCsv(text);
    read.mutate({ text, token });
  };

  const example = (column: number) =>
    preview?.sampleRows.map((r) => r[column] ?? '').find((v) => v.trim() !== '') ?? '';

  const footer = report ? (
    <>
      <Button onClick={reset}>{t('import.another')}</Button>
      <Button variant="primary" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={commit.isPending}>
        {t('common.cancel')}
      </Button>
      <Button
        variant="primary"
        disabled={!preview || commit.isPending || mapping.every((f) => f === 'ignore')}
        onClick={() => commit.mutate()}
      >
        {commit.isPending ? t('import.committing') : t('import.commit', { count: preview?.rowCount ?? 0 })}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={t('import.title')} wide footer={footer} busy={commit.isPending}>
      {report ? (
        <ReportView report={report} />
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <label htmlFor={fileId} className="text-xs font-medium text-soft">
              {t('import.chooseFile')}
            </label>
            <input
              id={fileId}
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="text-[13px] file:mr-3 file:rounded-md file:border file:border-rule file:bg-raised file:px-3 file:py-1.5 file:text-[13px] file:text-ink"
            />
            <p className="text-xs text-faint">{t('import.fileHint')}</p>
          </div>

          {fileError ? <Alert>{fileError}</Alert> : null}
          {read.isPending ? (
            <p role="status" className="text-[13px] text-soft">
              {t('import.reading')}
            </p>
          ) : null}
          {read.isError ? <Alert>{errorMessage(t, read.error)}</Alert> : null}
          {commit.isError ? <Alert>{errorMessage(t, commit.error)}</Alert> : null}

          {preview ? (
            <>
              <section className="grid gap-2" aria-labelledby="mapping-heading">
                <div className="flex items-baseline justify-between">
                  <h3 id="mapping-heading" className="text-[13px] font-semibold">
                    {t('import.mapping')}
                  </h3>
                  <span className="text-xs text-soft">{t('import.rows', { count: preview.rowCount })}</span>
                </div>
                <div className="overflow-x-auto rounded-md border border-rule">
                  <table className="w-full text-[13px]">
                    <thead className="bg-sunken text-left text-xs text-soft">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t('import.column')}</th>
                        <th className="px-3 py-2 font-medium">{t('import.example')}</th>
                        <th className="w-60 px-3 py-2 font-medium">{t('import.field')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {preview.headers.map((header, i) => (
                        <tr key={`${header}-${i}`}>
                          <td className="px-3 py-1.5 font-medium">{header}</td>
                          <td className="max-w-64 truncate px-3 py-1.5 text-soft">{example(i)}</td>
                          <td className="px-3 py-1.5">
                            <Select
                              aria-label={`${t('import.field')}: ${header}`}
                              value={mapping[i] ?? 'ignore'}
                              onChange={(e) =>
                                setMapping((m) =>
                                  m.map((f, j) => (j === i ? (e.target.value as ImportField) : f)),
                                )
                              }
                            >
                              {FIELDS.map((f) => (
                                <option key={f} value={f}>
                                  {translateKey(t, fieldKey(f), f)}
                                </option>
                              ))}
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <fieldset className="grid gap-2">
                <legend className="mb-1 text-[13px] font-semibold">{t('import.onMatch')}</legend>
                {MATCH_OPTIONS.map((option) => (
                  <label key={option} className="flex items-center gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="onMatch"
                      value={option}
                      checked={onMatch === option}
                      onChange={() => setOnMatch(option)}
                      className="accent-accent"
                    />
                    {t(`import.onMatchOptions.${option}`)}
                  </label>
                ))}
                <p className="text-xs text-faint">{t('import.matchRules')}</p>
              </fieldset>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function ReportView({ report }: { report: ImportReport }) {
  const { t } = useTranslation();
  const stats = [
    { label: t('import.inserted'), value: report.inserted },
    { label: t('import.updatedCount'), value: report.updated },
    { label: t('import.skipped'), value: report.skipped },
    { label: t('import.invalid'), value: report.invalid },
  ];
  return (
    <div className="grid gap-5" data-testid="import-report">
      <Alert tone={report.invalid ? 'warn' : 'ok'}>{t('import.done')}</Alert>
      <dl className="grid grid-cols-4 divide-x divide-rule rounded-md border border-rule">
        {stats.map((s) => (
          <div key={s.label} className="grid gap-0.5 px-4 py-3">
            <dt className="text-xs text-soft">{s.label}</dt>
            <dd className="font-mono text-xl tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
      {report.errors.length > 0 ? (
        <section className="grid gap-2" aria-labelledby="import-errors">
          <h3 id="import-errors" className="text-[13px] font-semibold">
            {t('import.errorsTitle')}
          </h3>
          <ul className="max-h-60 divide-y divide-rule overflow-y-auto rounded-md border border-rule text-[13px]">
            {report.errors.map((e) => (
              <li key={e.row} className="grid grid-cols-[90px_1fr] gap-3 px-3 py-1.5">
                <span className="font-mono text-xs text-soft">{t('import.row', { row: e.row })}</span>
                <span>{translateKey(t, `errors.${e.reason}`, e.reason)}</span>
              </li>
            ))}
          </ul>
          {report.errorsTruncated ? (
            <p className="text-xs text-faint">{t('import.errorsTruncated')}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
