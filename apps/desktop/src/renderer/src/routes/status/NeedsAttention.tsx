import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Job, UncertainSend } from '@tabreach/protocol';
import { useState } from 'react';
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
  const uncertain = useUncertainSends();
  return (
    <section className="grid gap-3" aria-labelledby="attention-heading">
      <div className="grid gap-1">
        <h2 id="attention-heading" className="text-[14px] font-semibold">
          {t('attention.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('attention.subtitle')}</p>
      </div>
      {jobs.isError ? <Alert tone="warn">{errorMessage(t, jobs.error)}</Alert> : null}
      {jobs.isSuccess && items.length === 0 && uncertain.isSuccess && uncertain.data.items.length === 0 ? (
        <p className="text-[13px] text-soft">{t('attention.empty')}</p>
      ) : null}
      <UncertainSends />
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
    ? translateKey(
        t,
        `attention.errors.${job.lastErrorClass}`,
        t('attention.errors.other', { code: job.lastErrorClass }),
      )
    : t('attention.errors.unexpected');
  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5 text-[13px]">
      <span className="grid gap-0.5">
        <span className="flex items-center gap-2 font-medium">
          {translateKey(t, `attention.types.${job.type}`, t('attention.types.other'))}
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

/** Channels whose sends are browser actions: the person checks the site, not a Sent folder. */
const BROWSER_CHANNELS = new Set(['web_form', 'linkedin']);

const useUncertainSends = () =>
  useQuery({ queryKey: ['jobs', 'uncertain'], queryFn: () => call('sideEffects.uncertain', {}) });

/**
 * Sends whose outcome TabReach could not verify. Only a person can say whether they went out;
 * until then nothing is sent to that person for that step (ADR 018, audit 3.5).
 */
function UncertainSends() {
  const { t } = useTranslation();
  const uncertain = useUncertainSends();
  const items = uncertain.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="grid gap-2">
      <h3 className="text-[13px] font-semibold">{t('attention.uncertainTitle')}</h3>
      <p className="text-xs text-soft">{t('attention.resolveHint')}</p>
      <ul
        aria-label={t('attention.uncertainTitle')}
        className="divide-y divide-rule rounded-md border border-rule bg-raised"
      >
        {items.map((item) => (
          <UncertainRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function UncertainRow({ item }: { item: UncertainSend }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmNotSent, setConfirmNotSent] = useState(false);
  const resolve = useMutation({
    mutationFn: (outcome: 'completed' | 'not_sent') => call('sideEffects.resolve', { id: item.id, outcome }),
    onSuccess: () => invalidateEntities(qc, ['job', 'enrollment', 'conversation', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  return (
    <li
      data-testid="uncertain-send"
      className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5 text-[13px]"
    >
      <span className="grid gap-0.5">
        <span className="font-medium">
          {item.contactName} &lt;{item.target}&gt;
        </span>
        <span className="text-soft">
          {[
            item.source === 'reply' ? t('attention.replySource') : item.campaignName,
            translateKey(t, `campaigns.channels.${item.channel}`, item.channel),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="font-mono text-[11px] text-faint">
          {formatDateTime(item.attemptedAt, i18n.language)}
        </span>
        {item.checking ? <span className="text-xs text-warn">{t('attention.checking')}</span> : null}
        {BROWSER_CHANNELS.has(item.channel) ? (
          <span className="text-xs text-soft">{t('attention.browserHint')}</span>
        ) : null}
        {confirmNotSent ? (
          <span className="text-xs text-warn">
            {t(item.source === 'reply' ? 'attention.replyNotSentHint' : 'attention.notSentHint')}
          </span>
        ) : null}
      </span>
      <span className="flex gap-1">
        <Button
          size="sm"
          onClick={() => resolve.mutate('completed')}
          disabled={resolve.isPending || item.checking}
        >
          {t('attention.wasSent')}
        </Button>
        {confirmNotSent ? (
          <>
            <Button
              size="sm"
              variant="danger"
              onClick={() => resolve.mutate('not_sent')}
              disabled={resolve.isPending || item.checking}
            >
              {t(item.source === 'reply' ? 'attention.confirmReplyNotSent' : 'attention.confirmNotSent')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmNotSent(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          // "Not sent" makes TabReach send it now: a second click confirms (audit 4.5).
          <Button
            size="sm"
            onClick={() => setConfirmNotSent(true)}
            disabled={resolve.isPending || item.checking}
          >
            {t('attention.wasNotSent')}
          </Button>
        )}
      </span>
    </li>
  );
}
