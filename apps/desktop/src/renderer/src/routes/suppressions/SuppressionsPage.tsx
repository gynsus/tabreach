import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Suppression, type SuppressionKind } from '@tabreach/protocol';
import { Upload } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Select,
} from '../../components/ui';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { usePagedList } from '../../lib/lists';
import { invalidateEntities } from '../../lib/live';

/** Kinds a user can type in; companies are suppressed from their company page. */
const KINDS: SuppressionKind[] = ['email', 'domain', 'profile_url'];

export function SuppressionsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<SuppressionKind>('email');
  const [value, setValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const importId = useId();
  const { query, rows, total, searching } = usePagedList('suppressions.list', search);

  const add = useMutation({
    mutationFn: () => call('suppressions.add', { kind, value }),
    onSuccess: async () => {
      setValue('');
      toast(t('suppressions.addedToast'));
      await invalidateEntities(qc, ['suppression', 'activity']);
    },
  });
  const importList = useMutation({
    // A fresh key per chosen file: a retry after a timeout does not import it twice.
    mutationFn: async (file: File) =>
      call('suppressions.import', { csv: await file.text() }, { idempotencyKey: uuidv7() }),
    onSuccess: async (r) => {
      toast(t('suppressions.importReport', r));
      await invalidateEntities(qc, ['suppression', 'activity']);
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) add.mutate();
  };
  const errors = fieldErrors(add.error);

  return (
    <>
      <PageHeader
        title={t('suppressions.title')}
        subtitle={t('suppressions.subtitle')}
        actions={
          <>
            <input
              id={importId}
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importList.mutate(file);
                e.target.value = '';
              }}
            />
            <Button
              onClick={() => fileRef.current?.click()}
              disabled={importList.isPending}
              title={t('suppressions.importHint')}
            >
              <Upload size={14} aria-hidden />
              {t('suppressions.importCsv')}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <form
          onSubmit={submit}
          className="flex flex-wrap items-start gap-3"
          aria-label={t('suppressions.add')}
        >
          <Field label={t('suppressions.kind')} className="w-40">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as SuppressionKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`suppressions.kinds.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('suppressions.value')} errorKey={errors.value} className="min-w-64 flex-1">
            {(id, describedBy) => (
              <Input
                id={id}
                value={value}
                placeholder={t(`suppressions.placeholders.${kind}`)}
                onChange={(e) => setValue(e.target.value)}
                aria-invalid={errors.value ? true : undefined}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Button variant="primary" type="submit" className="mt-5" disabled={add.isPending || !value.trim()}>
            {t('suppressions.add')}
          </Button>
        </form>
        {add.isError && !errors.value ? <Alert>{errorMessage(t, add.error)}</Alert> : null}

        <div className="flex items-center justify-between gap-3">
          <Input
            type="search"
            aria-label={t('suppressions.search')}
            placeholder={t('suppressions.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72"
          />
          {query.isSuccess ? (
            <span className="text-xs text-soft">{t('common.total', { count: total })}</span>
          ) : null}
        </div>

        {query.isPending ? <Loading /> : null}
        {query.isError ? <Alert>{errorMessage(t, query.error)}</Alert> : null}
        {query.isPending ? null : query.isSuccess && rows.length === 0 ? (
          searching ? (
            <EmptyState title={t('suppressions.noResults')} />
          ) : (
            <EmptyState title={t('suppressions.emptyTitle')} body={t('suppressions.emptyBody')} />
          )
        ) : (
          <ul
            className="divide-y divide-rule rounded-md border border-rule bg-raised"
            aria-label={t('suppressions.title')}
          >
            {rows.map((s) => (
              <SuppressionRow key={s.id} item={s} language={i18n.language} />
            ))}
          </ul>
        )}
        {query.hasNextPage ? (
          <Button
            className="justify-self-start"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
          </Button>
        ) : null}
      </div>
    </>
  );
}

function SuppressionRow({ item, language }: { item: Suppression; language: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => call('suppressions.remove', { id: item.id }),
    onSuccess: () => invalidateEntities(qc, ['suppression', 'activity']),
    onError: (error) => {
      setConfirming(false);
      toast(errorMessage(t, error), 'bad');
    },
  });
  return (
    <li className="grid grid-cols-[120px_1fr_160px_150px_auto] items-center gap-4 px-3 py-2 text-[13px]">
      <Badge tone="accent">{t(`suppressions.kinds.${item.kind}`)}</Badge>
      <span className="truncate font-medium">{item.value}</span>
      <span className="text-soft">{t(`suppressions.reasons.${item.reason}`)}</span>
      <span className="font-mono text-[11px] text-faint">{formatDateTime(item.createdAt, language)}</span>
      {confirming ? (
        <span className="flex gap-1">
          <Button size="sm" variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {t('common.confirmRemove')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          {t('common.remove')}
        </Button>
      )}
    </li>
  );
}
