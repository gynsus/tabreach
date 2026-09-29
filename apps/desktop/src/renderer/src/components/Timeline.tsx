import { useInfiniteQuery } from '@tanstack/react-query';
import type { ActionEvent, ActivityCategory, TimelineEntry } from '@tabreach/protocol';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { translateKey } from '../i18n';
import { call, errorMessage } from '../lib/api';
import { Alert, Badge, Button } from './ui';

export function describeEvent(t: TFunction, event: ActionEvent): { title: string; detail: string | null } {
  const title =
    event.actionType === 'message.send'
      ? translateKey(t, `activity.messageSend.${event.status}`, event.actionType)
      : translateKey(t, `activity.actions.${event.actionType}`, event.actionType);
  const p = event.payload;
  if (event.actionType === 'import.committed') {
    return { title, detail: t('activity.importSummary', p as Record<string, number>) };
  }
  if (Array.isArray(p.fields) && p.fields.length > 0) {
    const fields = (p.fields as string[]).map((f) => translateKey(t, `fieldNames.${f}`, f)).join(', ');
    return { title, detail: t('activity.changedFields', { fields }) };
  }
  if (event.actionType === 'enrollment.stopped' && typeof p.reason === 'string') {
    return { title, detail: translateKey(t, `campaigns.stopReasons.${p.reason}`, p.reason) };
  }
  if (event.actionType === 'message.classified' && typeof p.label === 'string') {
    return { title, detail: translateKey(t, `inbox.labels.${p.label}`, p.label) };
  }
  if (event.actionType === 'draft.generated' && typeof p.facts === 'number') {
    return { title, detail: t('activity.factsUsed', { count: p.facts }) };
  }
  if (event.actionType === 'research.completed' && typeof p.verified === 'number') {
    return { title, detail: t('activity.factsFound', { count: p.verified }) };
  }
  if (typeof p.value === 'string') return { title, detail: p.value };
  return { title, detail: null };
}

export function formatDateTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

type Ref = 'contact' | 'company' | 'campaign';
const REF_PATH: Record<Ref, string> = { contact: 'contacts', company: 'companies', campaign: 'campaigns' };

/** One event: what happened, to whom and in which campaign, and the message if there is one. */
export function ActivityItem(props: { entry: TimelineEntry; refs: Ref[]; showDate?: 'column' | 'inline' }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const e = props.entry;
  const d = describeEvent(t, e);
  const refs = props.refs.map((r) => ({ kind: r, ref: e[r] })).filter((r) => r.ref !== null);
  const date = formatDateTime(e.createdAt, i18n.language);
  const actor = translateKey(t, `activity.actors.${e.actorType}`, e.actorType);
  return (
    <li
      className={
        props.showDate === 'column' ? 'grid grid-cols-[150px_1fr] gap-4 text-[13px]' : 'grid text-[13px]'
      }
    >
      {props.showDate === 'column' ? (
        <span className="font-mono text-[11px] leading-5 text-faint">{date}</span>
      ) : null}
      <span className="grid gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{d.title}</span>
          {props.showDate === 'column' ? <Badge>{actor}</Badge> : null}
        </span>
        {d.detail ? <span className="text-soft">{d.detail}</span> : null}
        {refs.length ? (
          <span className="flex flex-wrap gap-x-1.5 text-soft">
            {refs.map((r, i) => (
              <span key={r.kind}>
                {i > 0 ? '· ' : ''}
                <Link to={`/${REF_PATH[r.kind]}/${r.ref!.id}`} className="hover:text-accent hover:underline">
                  {r.ref!.name}
                </Link>
              </span>
            ))}
          </span>
        ) : null}
        {e.message ? (
          <span className="grid gap-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="justify-self-start text-left text-soft hover:text-accent"
            >
              {e.message.subject ? `«${e.message.subject}» ` : ''}
              <span className="text-xs text-accent">
                {open ? t('activity.hideMessage') : t('activity.showMessage')}
              </span>
            </button>
            {open ? (
              <span
                data-testid="activity-message"
                className="rounded-md border border-rule bg-raised p-3 whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {e.message.body}
              </span>
            ) : null}
          </span>
        ) : null}
        {props.showDate === 'column' ? null : (
          <span className="font-mono text-[11px] text-faint">
            {date} · {actor}
          </span>
        )}
      </span>
    </li>
  );
}

export type TimelineScope = { contactId: string } | { companyId: string } | { campaignId: string } | object;

/** Pages of the audit trail, newest first, for a scope and category (FR-AUD-002). */
export function useActivity(scope: TimelineScope, category?: ActivityCategory, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: ['activity', scope, category ?? 'all'],
    queryFn: ({ pageParam }) =>
      call('activity.list', {
        ...scope,
        ...(category ? { category } : {}),
        ...(pageParam ? { before: pageParam } : {}),
        limit: pageSize,
      }),
    initialPageParam: null as { createdAt: string; id: string } | null,
    getNextPageParam: (last) => {
      const tail = last.items.at(-1);
      return last.hasMore && tail ? { createdAt: tail.createdAt, id: tail.id } : null;
    },
  });
}

/** History of a contact, a company (with its contacts) or a campaign. */
export function Timeline(props: { scope: TimelineScope; refs: Ref[] }) {
  const { t } = useTranslation();
  const query = useActivity(props.scope);
  const events = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="grid content-start gap-3" aria-labelledby="timeline-heading" data-testid="timeline">
      <h2 id="timeline-heading" className="text-[13px] font-semibold">
        {t('common.history')}
      </h2>
      {query.isError ? <Alert>{errorMessage(t, query.error)}</Alert> : null}
      {events.length === 0 ? (
        <p className="text-[13px] text-faint">
          {query.isPending ? t('common.loading') : t('activity.empty')}
        </p>
      ) : (
        <ol className="grid gap-2.5 border-l border-rule pl-4">
          {events.map((entry) => (
            <ActivityItem key={entry.id} entry={entry} refs={props.refs} />
          ))}
        </ol>
      )}
      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}
