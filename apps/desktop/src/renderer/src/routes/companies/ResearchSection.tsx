import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Qualification, ResearchDetail, ResearchFact } from '@tabreach/protocol';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { Alert, Badge, Button, Field } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const tone: Record<Qualification, 'ok' | 'accent' | 'bad' | 'neutral'> = {
  match: 'ok',
  possible_match: 'accent',
  not_match: 'bad',
  insufficient_data: 'neutral',
};

/** Research on the company page (docs/16): run it, read verified facts with their quotes and sources. */
export function ResearchSection({ companyId, hasWebsite }: { companyId: string; hasWebsite: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [criteria, setCriteria] = useState('');
  const runs = useQuery({
    queryKey: ['research', companyId],
    queryFn: () => call('research.list', { companyId }),
  });
  const latest = runs.data?.items[0];
  const detail = useQuery({
    queryKey: ['research', 'run', latest?.id],
    queryFn: () => call('research.get', { id: latest?.id as string }),
    enabled: Boolean(latest),
  });
  const start = useMutation({
    mutationFn: () => call('research.start', { companyId, criteria: criteria.trim() || null }),
    onSuccess: () => invalidateEntities(qc, ['research', 'activity']),
  });
  const busy = latest?.status === 'pending' || latest?.status === 'running';
  return (
    <section
      aria-labelledby="research-heading"
      className="grid gap-4 rounded-md border border-rule bg-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="research-heading" className="text-[14px] font-semibold">
          {t('research.title')}
        </h2>
        {latest ? (
          <span className="font-mono text-[11px] text-faint">
            {t(`research.statuses.${latest.status}`)} · {formatDateTime(latest.startedAt, i18n.language)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('research.criteria')} hint={t('research.criteriaHint')} className="min-w-80 flex-1">
          {(id, describedBy) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              className="min-h-16 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] focus:border-accent focus:outline-none"
            />
          )}
        </Field>
        <Button
          variant="primary"
          onClick={() => start.mutate()}
          disabled={!hasWebsite || busy || start.isPending}
        >
          <Search size={14} aria-hidden />
          {busy ? t('research.running') : t('research.start')}
        </Button>
      </div>
      {!hasWebsite ? <p className="text-xs text-faint">{t('errors.research.noWebsite')}</p> : null}
      {start.isError ? <Alert>{errorMessage(t, start.error)}</Alert> : null}
      {latest?.status === 'failed' && latest.error ? (
        <Alert>{translateKey(t, `errors.${latest.error}`, t('errors.generic'))}</Alert>
      ) : null}
      {detail.data && detail.data.status === 'completed' ? <ResearchResult run={detail.data} /> : null}
    </section>
  );
}

function ResearchResult({ run }: { run: ResearchDetail }) {
  const { t } = useTranslation();
  const facts = run.facts.filter((f) => f.kind === 'fact' && f.verified);
  const unsupported = run.facts.filter((f) => f.kind === 'fact' && !f.verified);
  const inferences = run.facts.filter((f) => f.kind === 'inference');
  const source = (f: ResearchFact) => run.evidence.find((e) => e.id === f.evidenceId);
  return (
    <div className="grid gap-4 text-[13px]" data-testid="research-result">
      <div className="flex flex-wrap items-center gap-2">
        {run.qualification ? (
          <Badge tone={tone[run.qualification]}>{t(`research.qualifications.${run.qualification}`)}</Badge>
        ) : null}
        <span className="text-soft">{run.qualificationReason}</span>
      </div>
      {run.summary ? <p>{run.summary}</p> : null}
      {run.reasonToContact ? (
        <p>
          <span className="font-medium">{t('research.reasonToContact')}: </span>
          {run.reasonToContact}
        </p>
      ) : null}
      <div className="grid gap-2">
        <h3 className="text-xs font-semibold text-soft">{t('research.facts', { count: facts.length })}</h3>
        <ul className="grid gap-2">
          {facts.map((f) => (
            <li key={f.id} className="grid gap-0.5 border-l-2 border-accent pl-3">
              <span>{f.claim}</span>
              <span className="text-xs text-soft">«{f.quote}»</span>
              <span className="font-mono text-[11px] break-all text-faint">{source(f)?.url}</span>
            </li>
          ))}
        </ul>
      </div>
      {inferences.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="text-xs font-semibold text-soft">{t('research.inferences')}</h3>
          <ul className="grid list-disc gap-1 pl-5 text-soft">
            {inferences.map((f) => (
              <li key={f.id}>{f.claim}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {unsupported.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="text-xs font-semibold text-warn">{t('research.unsupported')}</h3>
          <p className="text-xs text-faint">{t('research.unsupportedHint')}</p>
          <ul className="grid list-disc gap-1 pl-5 text-faint line-through">
            {unsupported.map((f) => (
              <li key={f.id}>{f.claim}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.missingInformation.length > 0 ? (
        <p className="text-xs text-soft">
          {t('research.missing')}: {run.missingInformation.join(', ')}
        </p>
      ) : null}
      <p className="text-xs text-faint">
        {t('research.sources', { count: run.pagesFetched, skipped: run.pagesSkipped })} · {run.template} ·{' '}
        {run.model}
      </p>
    </div>
  );
}
