import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { describeEvent, formatDateTime } from '../../components/Timeline';
import { Alert, Badge, EmptyState, PageHeader } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';

const linkFor = (type: string | null, id: string | null) =>
  id && (type === 'company' || type === 'contact')
    ? `/${type === 'company' ? 'companies' : 'contacts'}/${id}`
    : null;

/** The audit trail as the user sees it (FR-AUD-002), newest first. */
export function ActivityPage() {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: ['activity', 'all'],
    queryFn: () => call('activity.list', { limit: 200 }),
  });
  const events = query.data?.items ?? [];
  return (
    <>
      <PageHeader title={t('activity.title')} subtitle={t('activity.subtitle')} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {query.isError ? <Alert>{errorMessage(t, query.error)}</Alert> : null}
        {query.isSuccess && events.length === 0 ? <EmptyState title={t('activity.empty')} /> : null}
        <ol className="grid max-w-3xl gap-3">
          {events.map((event) => {
            const d = describeEvent(t, event);
            const href = linkFor(event.objectType, event.objectId);
            return (
              <li key={event.id} className="grid grid-cols-[150px_1fr] gap-4 text-[13px]">
                <span className="font-mono text-[11px] leading-5 text-faint">
                  {formatDateTime(event.createdAt, i18n.language)}
                </span>
                <span className="grid gap-0.5">
                  <span className="flex items-center gap-2">
                    {href ? (
                      <Link to={href} className="font-medium hover:text-accent">
                        {d.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{d.title}</span>
                    )}
                    <Badge>{translateKey(t, `activity.actors.${event.actorType}`, event.actorType)}</Badge>
                  </span>
                  {d.detail ? <span className="text-soft">{d.detail}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
