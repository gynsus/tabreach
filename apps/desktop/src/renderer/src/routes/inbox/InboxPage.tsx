import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationMessage, ConversationSummary } from '@tabreach/protocol';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, EmptyState, PageHeader } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { invalidateEntities } from '../../lib/live';

type Filter = 'all' | 'unread' | 'review';

/** Unread count for the navigation badge. */
export function useInboxCounts() {
  return useQuery({
    queryKey: ['conversations', 'counts'],
    queryFn: () => call('conversations.list', { filter: 'unread', limit: 1, offset: 0 }),
  });
}

const tone = { reply: 'accent', out_of_office: 'neutral', auto: 'neutral', bounce: 'bad' } as const;

export function InboxPage() {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['conversations', filter],
    queryFn: () => call('conversations.list', { filter, limit: 200, offset: 0 }),
  });
  const items = list.data?.items ?? [];
  const current = items.find((c) => c.id === selected) ?? items[0];

  return (
    <>
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col border-r border-rule">
          <div role="tablist" aria-label={t('inbox.title')} className="flex gap-1 border-b border-rule p-2">
            {(['all', 'unread', 'review'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs',
                  filter === f ? 'bg-accent-soft font-medium text-accent' : 'text-soft hover:bg-sunken',
                )}
              >
                {t(`inbox.filters.${f}`)}
              </button>
            ))}
          </div>
          {list.isError ? (
            <div className="p-3">
              <Alert>{errorMessage(t, list.error)}</Alert>
            </div>
          ) : null}
          {list.isSuccess && items.length === 0 ? (
            <p className="p-4 text-[13px] text-soft">
              {filter === 'all' ? t('inbox.empty') : t('inbox.emptyFilter')}
            </p>
          ) : null}
          <ul aria-label={t('inbox.title')} className="min-h-0 flex-1 divide-y divide-rule overflow-y-auto">
            {items.map((c) => (
              <li key={c.id}>
                <ConversationItem
                  conversation={c}
                  active={c.id === current?.id}
                  language={i18n.language}
                  onSelect={() => setSelected(c.id)}
                />
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {current ? (
            <Thread key={current.id} summary={current} />
          ) : list.isSuccess ? (
            <EmptyState title={t('inbox.select')} />
          ) : null}
        </div>
      </div>
    </>
  );
}

function ConversationItem(props: {
  conversation: ConversationSummary;
  active: boolean;
  language: string;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const c = props.conversation;
  return (
    <button
      type="button"
      aria-current={props.active ? 'true' : undefined}
      onClick={props.onSelect}
      data-testid="conversation"
      className={cn(
        'grid w-full gap-1 px-4 py-2.5 text-left text-[13px] hover:bg-sunken',
        props.active && 'bg-accent-soft',
      )}
    >
      <span className="flex items-center gap-2">
        {c.unread ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" /> : null}
        <span className={cn('truncate', c.unread && 'font-semibold')}>{c.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
          {formatDateTime(c.lastMessageAt, props.language)}
        </span>
      </span>
      <span className="truncate text-xs text-soft">{c.lastSnippet}</span>
      <span className="flex gap-1">
        {c.lastClassification ? (
          <Badge tone={tone[c.lastClassification]}>
            {t(`inbox.classifications.${c.lastClassification}`)}
          </Badge>
        ) : null}
        {c.needsReview ? <Badge tone="warn">{t('inbox.filters.review')}</Badge> : null}
      </span>
    </button>
  );
}

function Thread({ summary }: { summary: ConversationSummary }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const conversation = useQuery({
    queryKey: ['conversations', 'thread', summary.id],
    queryFn: () => call('conversations.get', { id: summary.id }),
  });
  const markRead = useMutation({
    mutationFn: () => call('conversations.markRead', { id: summary.id }),
    onSuccess: () => invalidateEntities(qc, ['conversation']),
  });
  const { mutate } = markRead;
  useEffect(() => {
    if (summary.unread) mutate();
  }, [summary.unread, mutate]);

  if (conversation.isError) {
    return (
      <div className="p-6">
        <Alert>{errorMessage(t, conversation.error)}</Alert>
      </div>
    );
  }
  const data = conversation.data;
  if (!data) return null;
  return (
    <article aria-label={data.title} className="grid max-w-3xl gap-4 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold">{data.title}</h2>
        <span className="text-xs text-faint">{data.accountAddress}</span>
        {data.contactId ? (
          <Link
            to={`/contacts/${data.contactId}`}
            className="ml-auto text-[13px] text-accent hover:underline"
          >
            {t('inbox.openContact')}
          </Link>
        ) : null}
      </header>
      {data.messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
    </article>
  );
}

function Message({ message: m }: { message: ConversationMessage }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const review = useMutation({
    mutationFn: (decision: 'confirm' | 'dismiss') =>
      call('conversations.review', { messageId: m.id, decision }),
    onSuccess: () => invalidateEntities(qc, ['conversation', 'enrollment', 'campaign', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const suppress = useMutation({
    mutationFn: () => call('suppressions.add', { kind: 'email', value: m.from ?? '' }),
    onSuccess: async () => {
      toast(t('inbox.addedToList'));
      await invalidateEntities(qc, ['suppression', 'activity']);
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const outbound = m.direction === 'outbound';
  return (
    <section
      data-testid="message"
      data-direction={m.direction}
      className={cn(
        'grid gap-2 rounded-md border p-4',
        outbound ? 'border-rule bg-sunken' : 'border-rule bg-raised',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{outbound ? t('inbox.you') : m.from}</span>
        {m.classification ? (
          <Badge tone={tone[m.classification]}>{t(`inbox.classifications.${m.classification}`)}</Badge>
        ) : null}
        {m.label ? (
          <Badge
            tone={
              m.label === 'interested'
                ? 'ok'
                : m.label === 'opt_out' || m.label === 'not_interested'
                  ? 'bad'
                  : 'neutral'
            }
          >
            AI · {t(`inbox.labels.${m.label}`)}
          </Badge>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-faint">
          {formatDateTime(m.occurredAt, i18n.language)}
        </span>
      </div>
      {m.subject ? <p className="text-[13px] font-semibold">{m.subject}</p> : null}
      <p className="text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>
      {m.reviewStatus === 'pending' ? (
        <div className="grid gap-2 rounded-md bg-warn-bg p-3 text-[13px] text-warn">
          <p>{t('inbox.possible')}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => review.mutate('confirm')} disabled={review.isPending}>
              {t('inbox.confirm')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => review.mutate('dismiss')}
              disabled={review.isPending}
            >
              {t('inbox.dismiss')}
            </Button>
          </div>
          <p className="text-xs">{t('inbox.confirmHint')}</p>
        </div>
      ) : null}
      {!outbound && m.from && m.classification === 'reply' ? (
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start"
          onClick={() => suppress.mutate()}
          disabled={suppress.isPending}
        >
          {t('inbox.doNotContact')}
        </Button>
      ) : null}
    </section>
  );
}
