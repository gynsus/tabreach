import { useQuery } from '@tanstack/react-query';
import type { Campaign, ConversationSummary } from '@tabreach/protocol';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Alert, Badge, Loading, PageHeader } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDateTime } from '../../components/Timeline';
import { usePendingApprovals } from '../approvals/ApprovalsPage';
import { DOT, useSystemSummary } from '../status/SystemIndicator';
import { useOpenTasks } from '../tasks/TasksPage';

/** Interested replies first, then the rest by time (the list comes newest first). */
const LABEL_ORDER = { interested: 0, other: 1, out_of_office: 2, not_interested: 3, opt_out: 4 } as const;

function useUnreadReplies() {
  return useQuery({
    queryKey: ['conversations', 'today'],
    queryFn: () => call('conversations.list', { filter: 'unread', limit: 50, offset: 0 }),
  });
}

function useCampaigns() {
  return useQuery({ queryKey: ['campaigns', 'list'], queryFn: () => call('campaigns.list', {}) });
}

/**
 * The home screen (docs/22 9a): what needs the user now — replies, messages to review, tasks and
 * anything stuck — then the running campaigns and whether the app itself is fine. No charts.
 */
export function TodayPage() {
  const { t } = useTranslation();
  const replies = useUnreadReplies();
  const review = usePendingApprovals();
  const tasks = useOpenTasks();
  const campaigns = useCampaigns();
  const system = useSystemSummary();

  const unread = replies.data?.items ?? [];
  const interested = unread.filter((c) => c.lastLabel === 'interested').length;
  const cards = [
    {
      to: '/inbox',
      count: replies.data?.unread ?? 0,
      label: t('today.replies'),
      note: interested ? t('today.interested', { count: interested }) : null,
    },
    { to: '/approvals', count: review.data?.items.length ?? 0, label: t('today.review'), note: null },
    { to: '/tasks', count: tasks.data?.total ?? 0, label: t('today.tasks'), note: null },
    { to: '/status', count: system.attention, label: t('today.attention'), note: null },
  ];
  const nothing = cards.every((c) => c.count === 0);
  const loading = replies.isPending || review.isPending || tasks.isPending;
  const running = (campaigns.data?.items ?? []).filter((c) => c.status === 'active' || c.status === 'paused');

  return (
    <>
      <PageHeader title={t('today.title')} subtitle={t('today.subtitle')} />
      <div className="grid min-h-0 flex-1 content-start gap-8 overflow-y-auto p-6">
        <section aria-labelledby="today-attention" className="grid gap-3">
          <h2 id="today-attention" className="text-[15px] font-semibold">
            {t('today.needsYou')}
          </h2>
          {loading ? <Loading /> : null}
          {!loading && nothing ? (
            <p className="text-[13px] text-soft" data-testid="today-clear">
              {t('today.clear')}
            </p>
          ) : null}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
            {cards.map((c) => (
              <li key={c.to}>
                <Link
                  to={c.to}
                  data-testid={`today-${c.to.slice(1)}`}
                  data-count={c.count}
                  className={cn(
                    'grid gap-1 rounded-md border border-rule bg-raised p-4 hover:border-accent',
                    c.count === 0 && 'opacity-60',
                  )}
                >
                  <span className="font-mono text-2xl leading-none">{c.count}</span>
                  <span className="text-[13px] font-medium">{c.label}</span>
                  {c.note ? <span className="text-xs text-accent">{c.note}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
          {replies.isError ? <Alert>{errorMessage(t, replies.error)}</Alert> : null}
          {unread.length ? <ReplyList items={unread} /> : null}
        </section>

        <section aria-labelledby="today-campaigns" className="grid gap-3">
          <h2 id="today-campaigns" className="text-[15px] font-semibold">
            {t('today.campaigns')}
          </h2>
          {campaigns.isError ? <Alert>{errorMessage(t, campaigns.error)}</Alert> : null}
          {campaigns.isSuccess && running.length === 0 ? (
            <p className="text-[13px] text-soft">
              {t('today.noCampaigns')}{' '}
              <Link to="/campaigns" className="text-accent hover:underline">
                {t('today.openCampaigns')}
              </Link>
            </p>
          ) : null}
          {running.length ? (
            <ul className="divide-y divide-rule rounded-md border border-rule bg-raised">
              {running.map((c) => (
                <CampaignRow key={c.id} campaign={c} />
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-labelledby="today-system" className="grid gap-2">
          <h2 id="today-system" className="text-[15px] font-semibold">
            {t('today.system')}
          </h2>
          <p
            className="flex items-center gap-2 text-[13px]"
            data-testid="today-system"
            data-tone={system.tone}
          >
            <span aria-hidden className={cn('size-2 rounded-full', DOT[system.tone])} />
            {system.text}
            <Link to="/status" className="text-accent hover:underline">
              {t('today.details')}
            </Link>
          </p>
        </section>
      </div>
    </>
  );
}

function ReplyList({ items }: { items: ConversationSummary[] }) {
  const { t, i18n } = useTranslation();
  const sorted = [...items]
    .sort((a, b) => LABEL_ORDER[a.lastLabel ?? 'other'] - LABEL_ORDER[b.lastLabel ?? 'other'])
    .slice(0, 5);
  return (
    <ul
      aria-label={t('today.replies')}
      className="divide-y divide-rule rounded-md border border-rule bg-raised"
    >
      {sorted.map((c) => (
        <li key={c.id}>
          <Link to="/inbox" className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-sunken">
            <span className="w-40 shrink-0 truncate font-medium">{c.title}</span>
            {c.lastLabel ? (
              <Badge tone={c.lastLabel === 'interested' ? 'accent' : 'neutral'}>
                {t(`inbox.labels.${c.lastLabel}`)}
              </Badge>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-soft">{c.lastSnippet}</span>
            <span className="shrink-0 font-mono text-[11px] text-faint">
              {formatDateTime(c.lastMessageAt, i18n.language)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  const { t } = useTranslation();
  return (
    <li>
      <Link
        to={`/campaigns/${c.id}`}
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[13px] hover:bg-sunken"
      >
        <span className="font-medium">{c.name}</span>
        <Badge tone={c.status === 'active' ? 'ok' : 'warn'}>{t(`campaigns.statuses.${c.status}`)}</Badge>
        <span className="text-soft">
          {t('today.campaignLine', {
            sent: c.results.sent,
            replied: c.results.replied,
            active: c.enrollments.active ?? 0,
          })}
        </span>
        {c.pendingApprovals ? (
          <span className="text-accent">{t('today.toReview', { count: c.pendingApprovals })}</span>
        ) : null}
        <ChevronRight size={14} aria-hidden className="ml-auto text-faint" />
      </Link>
    </li>
  );
}
