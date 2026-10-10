import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Campaign, type Enrollment, type EnrollmentStatus } from '@tabreach/protocol';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { formatWindow } from '../../components/WindowEditor';
import { Alert, Badge, Button, Input, Modal } from '../../components/ui';
import { ExportButton } from '../imports/ExportButton';
import { call, errorMessage, PAGE_SIZE } from '../../lib/api';
import { usePagedList } from '../../lib/lists';
import { invalidateEntities } from '../../lib/live';

const tone: Record<EnrollmentStatus, 'ok' | 'warn' | 'neutral' | 'bad'> = {
  active: 'ok',
  paused: 'warn',
  completed: 'neutral',
  stopped: 'bad',
};

export function PeopleSection({ campaign }: { campaign: Campaign }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const canEnroll =
    campaign.activeVersion !== null && (campaign.status === 'active' || campaign.status === 'paused');
  const list = useInfiniteQuery({
    queryKey: ['enrollments', campaign.id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      call('enrollments.list', { campaignId: campaign.id, limit: PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="people-heading" className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="people-heading" className="text-[15px] font-semibold">
          {t('campaigns.people')}
        </h2>
        <div className="flex items-center gap-2">
          {rows.length > 0 ? <ExportButton campaignId={campaign.id} /> : null}
          <Button
            onClick={() => setAdding(true)}
            disabled={!canEnroll}
            title={canEnroll ? undefined : t('campaigns.launchFirst')}
          >
            <UserPlus size={14} aria-hidden />
            {t('campaigns.addPeople')}
          </Button>
        </div>
      </div>
      {list.isError ? <Alert>{errorMessage(t, list.error)}</Alert> : null}
      {list.isSuccess && rows.length === 0 ? (
        <p className="text-[13px] text-soft">
          {canEnroll ? t('campaigns.peopleEmpty') : t('campaigns.launchFirst')}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul
          aria-label={t('campaigns.people')}
          className="divide-y divide-rule rounded-md border border-rule bg-raised"
        >
          {rows.map((e) => (
            <EnrollmentRow key={e.id} enrollment={e} />
          ))}
        </ul>
      ) : null}
      {list.hasNextPage ? (
        <Button
          className="justify-self-start"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
        </Button>
      ) : null}
      {adding ? <AddPeople campaignId={campaign.id} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}

function EnrollmentRow({ enrollment: e }: { enrollment: Enrollment }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const act = useMutation({
    mutationFn: (action: 'enrollments.pause' | 'enrollments.resume' | 'enrollments.stop') =>
      call(action, { id: e.id }),
    onSuccess: () => invalidateEntities(qc, ['enrollment', 'campaign', 'approval', 'activity']),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
    onSettled: () => setConfirmStop(false),
  });
  const live = e.status === 'active' || e.status === 'paused';
  let next: string | null = null;
  let detail: string | null = null;
  const at = e.nextActionAt ? formatDateTime(e.nextActionAt, i18n.language) : null;
  if (e.status === 'stopped' && e.stopReason) next = t(`campaigns.stopReasons.${e.stopReason}`);
  else if (e.waiting === 'window' && at && e.sendingHours) {
    next = t('campaigns.waitingWindow', { at });
    detail = t('campaigns.sendingHours', {
      hours: formatWindow(e.sendingHours.window, i18n.language),
      zone: e.sendingHours.timeZone,
    });
  } else if (e.waiting === 'schedule' && at) next = at;
  else if (e.waiting) next = t(`campaigns.waiting.${e.waiting}`);
  return (
    <li
      data-testid="enrollment"
      data-status={e.status}
      className="grid grid-cols-[minmax(180px,2fr)_120px_110px_minmax(160px,2fr)_auto] items-center gap-4 px-4 py-2 text-[13px]"
    >
      <span className="grid min-w-0 gap-0.5">
        <Link to={`/contacts/${e.contactId}`} className="truncate font-medium hover:underline">
          {e.contactName}
        </Link>
        <span className="truncate text-xs text-faint">{e.email}</span>
      </span>
      <span>
        <Badge tone={tone[e.status]}>{t(`campaigns.enrollmentStatuses.${e.status}`)}</Badge>
      </span>
      <span className="text-soft">
        {t('campaigns.step', { position: Math.min(e.stepPosition, e.stepCount), count: e.stepCount })}
      </span>
      <span className="grid min-w-0 gap-0.5 text-soft">
        <span className="truncate" title={detail ?? undefined}>
          {next ?? t('common.none')}
        </span>
        {detail ? <span className="truncate text-xs text-faint">{detail}</span> : null}
      </span>
      <span className="flex gap-1">
        {e.status === 'active' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => act.mutate('enrollments.pause')}
            disabled={act.isPending}
          >
            {t('campaigns.pause')}
          </Button>
        ) : null}
        {e.status === 'paused' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => act.mutate('enrollments.resume')}
            disabled={act.isPending}
          >
            {t('campaigns.resume')}
          </Button>
        ) : null}
        {live ? (
          confirmStop ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => act.mutate('enrollments.stop')}
              disabled={act.isPending}
            >
              {t('campaigns.confirmStop')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)}>
              {t('campaigns.stop')}
            </Button>
          )
        ) : null}
      </span>
    </li>
  );
}

function AddPeople(props: { campaignId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [key] = useState(uuidv7);
  const { query, rows } = usePagedList('contacts.list', search);
  const enroll = useMutation({
    mutationFn: () =>
      call(
        'campaigns.enroll',
        { campaignId: props.campaignId, contactIds: [...selected] },
        { idempotencyKey: key },
      ),
    onSuccess: async (report) => {
      toast(t('campaigns.enrollReport', report));
      await invalidateEntities(qc, ['enrollment', 'campaign', 'activity']);
      props.onClose();
    },
  });
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const active = rows.filter((c) => c.status === 'active');
  return (
    <Modal
      open
      wide
      onClose={props.onClose}
      title={t('campaigns.addPeople')}
      busy={enroll.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={enroll.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => enroll.mutate()}
            disabled={enroll.isPending || selected.size === 0}
          >
            {t('campaigns.addSelected', { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Input
          type="search"
          aria-label={t('campaigns.searchContacts')}
          placeholder={t('campaigns.searchContacts')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        {enroll.isError ? <Alert>{errorMessage(t, enroll.error)}</Alert> : null}
        {query.isError ? <Alert>{errorMessage(t, query.error)}</Alert> : null}
        <ul
          aria-label={t('nav.contacts')}
          className="max-h-[50vh] divide-y divide-rule overflow-y-auto rounded-md border border-rule"
        >
          {active.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-3 px-3 py-2 text-[13px] hover:bg-sunken">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="font-medium">{c.displayName}</span>
                <span className="truncate text-faint">
                  {[c.email, c.companyName].filter(Boolean).join(' · ')}
                </span>
              </label>
            </li>
          ))}
        </ul>
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
    </Modal>
  );
}
