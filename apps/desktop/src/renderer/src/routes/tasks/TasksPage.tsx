import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HumanTask } from '@tabreach/protocol';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, PageHeader } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

/** Open tasks, for the counter in the navigation. */
export function useOpenTasks() {
  return useQuery({
    queryKey: ['tasks', 'open'],
    queryFn: () => call('tasks.list', { status: 'open', limit: 500 }),
  });
}

/** Tasks from campaign steps the person does themselves (docs/17 human_task). */
export function TasksPage() {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const list = useQuery({
    queryKey: ['tasks', all ? 'all' : 'open'],
    queryFn: () => call('tasks.list', { status: all ? 'all' : 'open', limit: 500 }),
  });
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={t('tasks.title')}
        subtitle={t('tasks.subtitle')}
        actions={
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            {t('tasks.showDone')}
          </label>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid max-w-4xl gap-3 p-6">
          {list.isError ? <Alert>{errorMessage(t, list.error)}</Alert> : null}
          {list.isSuccess && items.length === 0 ? (
            <p className="text-[13px] text-soft">{t('tasks.empty')}</p>
          ) : null}
          {items.length > 0 ? (
            <ul
              aria-label={t('tasks.title')}
              className="divide-y divide-rule rounded-md border border-rule bg-raised"
            >
              {items.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </>
  );
}

const statusTone = { open: 'warn', done: 'ok', skipped: 'neutral', cancelled: 'neutral' } as const;

function TaskRow({ task }: { task: HumanTask }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const resolve = useMutation({
    mutationFn: (outcome: 'done' | 'skip' | 'stop') => call('tasks.resolve', { id: task.id, outcome }),
    onSuccess: () => invalidateEntities(qc, ['task', 'enrollment', 'campaign', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
    onSettled: () => setConfirmStop(false),
  });
  const open = task.status === 'open';
  return (
    <li className="grid gap-2 px-4 py-3 text-[13px]" data-testid="task" data-status={task.status}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="font-medium">{task.title}</span>
          <span className="text-xs text-soft">
            <Link to={`/contacts/${task.contactId}`} className="hover:underline">
              {task.contactName}
            </Link>
            {task.companyName ? ` · ${task.companyName}` : ''}
            {task.email ? ` · ${task.email}` : ''}
          </span>
          <span className="text-xs text-faint">
            <Link to={`/campaigns/${task.campaignId}`} className="hover:underline">
              {task.campaignName}
            </Link>{' '}
            · {t('campaigns.stepTitle.human_task', { n: task.stepPosition })} ·{' '}
            {formatDateTime(task.createdAt, i18n.language)}
          </span>
        </div>
        {open ? (
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="primary"
              onClick={() => resolve.mutate('done')}
              disabled={resolve.isPending}
            >
              {t('tasks.done')}
            </Button>
            <Button size="sm" onClick={() => resolve.mutate('skip')} disabled={resolve.isPending}>
              {t('tasks.skip')}
            </Button>
            {confirmStop ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => resolve.mutate('stop')}
                disabled={resolve.isPending}
              >
                {t('tasks.confirmStop')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmStop(true)}
                disabled={resolve.isPending}
              >
                {t('tasks.stop')}
              </Button>
            )}
          </span>
        ) : (
          <Badge tone={statusTone[task.status]}>{t(`tasks.statuses.${task.status}`)}</Badge>
        )}
      </div>
      {task.instructions ? <p className="whitespace-pre-wrap text-soft">{task.instructions}</p> : null}
    </li>
  );
}
