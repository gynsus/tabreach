import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Job } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

/** Dead and failed background jobs, with retry and dismiss (docs/06, "Jobs and diagnostics"). */
export function NeedsAttention() {
  const { t } = useTranslation();
  const jobs = useQuery({ queryKey: ['jobs', 'attention'], queryFn: () => call('jobs.needsAttention', {}) });
  const items = jobs.data?.items ?? [];
  return (
    <section className="grid gap-3" aria-labelledby="attention-heading">
      <div className="grid gap-1">
        <h2 id="attention-heading" className="text-[14px] font-semibold">
          {t('attention.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('attention.subtitle')}</p>
      </div>
      {jobs.isError ? <Alert tone="warn">{errorMessage(t, jobs.error)}</Alert> : null}
      {jobs.isSuccess && items.length === 0 ? (
        <p className="text-[13px] text-soft">{t('attention.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <ul
          aria-label={t('attention.title')}
          className="divide-y divide-rule rounded-md border border-rule bg-raised"
        >
          {items.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function JobRow({ job }: { job: Job }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const act = useMutation({
    mutationFn: (action: 'jobs.retry' | 'jobs.dismiss') => call(action, { id: job.id }),
    onSuccess: () => invalidateEntities(qc, ['job', 'enrollment', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const reason = job.lastErrorClass
    ? translateKey(t, `attention.errors.${job.lastErrorClass}`, job.lastErrorClass)
    : t('attention.errors.unexpected');
  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5 text-[13px]">
      <span className="grid gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          {translateKey(t, `attention.types.${job.type}`, job.type)}
          <Badge tone={job.status === 'dead' ? 'bad' : 'warn'}>
            {t('attention.attempts', { count: job.attempts })}
          </Badge>
        </span>
        <span className="text-soft">{reason}</span>
        <span className="font-mono text-[11px] text-faint">
          {formatDateTime(job.updatedAt, i18n.language)}
        </span>
      </span>
      <span className="flex gap-1">
        <Button size="sm" onClick={() => act.mutate('jobs.retry')} disabled={act.isPending}>
          {t('attention.retry')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => act.mutate('jobs.dismiss')} disabled={act.isPending}>
          {t('attention.dismiss')}
        </Button>
      </span>
    </li>
  );
}
