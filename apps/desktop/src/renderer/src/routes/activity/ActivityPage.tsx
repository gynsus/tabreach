import { activityCategorySchema, type ActivityCategory } from '@tabreach/protocol';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityItem, useActivity } from '../../components/Timeline';
import { Alert, Button, EmptyState, PageHeader } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';

const FILTERS: (ActivityCategory | 'all')[] = ['all', ...activityCategorySchema.options];

/** The audit trail as the user sees it (FR-AUD-002): newest first, with whom and which campaign. */
export function ActivityPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<ActivityCategory | 'all'>('all');
  const query = useActivity({}, filter === 'all' ? undefined : filter, 100);
  const events = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader title={t('activity.title')} subtitle={t('activity.subtitle')} />
      <div
        role="tablist"
        aria-label={t('activity.title')}
        className="flex flex-wrap gap-1 border-b border-rule px-6"
      >
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[13px]',
              filter === f
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-soft hover:text-ink',
            )}
          >
            {t(`activity.categories.${f}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-6">
        {query.isError ? <Alert>{errorMessage(t, query.error)}</Alert> : null}
        {query.isSuccess && events.length === 0 ? <EmptyState title={t('activity.empty')} /> : null}
        <ol className="grid max-w-3xl gap-3">
          {events.map((entry) => (
            <ActivityItem
              key={entry.id}
              entry={entry}
              refs={['contact', 'company', 'campaign']}
              showDate="column"
            />
          ))}
        </ol>
        {query.hasNextPage ? (
          <Button
            variant="ghost"
            className="mt-4"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
          </Button>
        ) : null}
      </div>
    </>
  );
}
