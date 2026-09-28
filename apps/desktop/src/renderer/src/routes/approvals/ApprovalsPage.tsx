import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Approval } from '@tabreach/protocol';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Button, DetailList, EmptyState, Field, Input, PageHeader } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { invalidateEntities } from '../../lib/live';

type Decision = 'approve' | 'skip' | 'reject';

/** Pending approvals, shared with the navigation badge. */
export function usePendingApprovals() {
  return useQuery({ queryKey: ['approvals', 'pending'], queryFn: () => call('approvals.pending', {}) });
}

/** Batch approval queue (FR-APR-001…005), driven by keyboard: A / E / S / R, J / K. */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const pending = usePendingApprovals();
  const items = pending.data?.items ?? [];
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const current = items[Math.min(index, Math.max(items.length - 1, 0))];

  const refresh = () => invalidateEntities(qc, ['approval', 'enrollment', 'campaign', 'activity']);
  const decide = useMutation({
    mutationFn: ({ decision, approval }: { decision: Decision; approval: Approval }) =>
      decision === 'approve'
        ? call('approvals.approve', { approvalId: approval.id, contentHash: approval.contentHash })
        : call(decision === 'skip' ? 'approvals.skip' : 'approvals.reject', { approvalId: approval.id }),
    onSuccess: (_r, { decision }) => {
      toast(
        t(
          `approvals.decided.${decision === 'approve' ? 'approved' : decision === 'skip' ? 'skipped' : 'rejected'}`,
        ),
      );
      return refresh();
    },
    onError: (error) => {
      toast(errorMessage(t, error), 'bad');
      return refresh();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || !current || decide.isPending) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'a') decide.mutate({ decision: 'approve', approval: current });
      else if (key === 's') decide.mutate({ decision: 'skip', approval: current });
      else if (key === 'r') decide.mutate({ decision: 'reject', approval: current });
      else if (key === 'e') setEditing(true);
      else if (key === 'j' || e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, items.length - 1));
      else if (key === 'k' || e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, decide, editing, items.length]);

  return (
    <>
      <PageHeader title={t('approvals.title')} subtitle={t('approvals.subtitle')} />
      {pending.isError ? (
        <div className="p-6">
          <Alert>{errorMessage(t, pending.error)}</Alert>
        </div>
      ) : null}
      {pending.isSuccess && items.length === 0 ? (
        <EmptyState title={t('approvals.emptyTitle')} body={t('approvals.emptyBody')} />
      ) : null}
      {current ? (
        <div className="flex min-h-0 flex-1">
          <ul
            aria-label={t('approvals.title')}
            className="w-72 shrink-0 divide-y divide-rule overflow-y-auto border-r border-rule"
          >
            {items.map((a, i) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-current={a.id === current.id ? 'true' : undefined}
                  onClick={() => {
                    setIndex(i);
                    setEditing(false);
                  }}
                  className={cn(
                    'grid w-full gap-0.5 px-4 py-2 text-left text-[13px] hover:bg-sunken',
                    a.id === current.id && 'bg-accent-soft',
                  )}
                >
                  <span className="truncate font-medium">{a.contactName}</span>
                  <span className="truncate text-xs text-faint">
                    {a.campaignName} · {t('approvals.step', { n: a.stepPosition })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            <ApprovalDetail
              key={`${current.id}-${editing}`}
              approval={current}
              position={t('approvals.position', { index: items.indexOf(current) + 1, count: items.length })}
              editing={editing}
              busy={decide.isPending}
              onEdit={setEditing}
              onDecide={(decision) => decide.mutate({ decision, approval: current })}
              onRevised={async () => {
                setEditing(false);
                await refresh();
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ApprovalDetail(props: {
  approval: Approval;
  position: string;
  editing: boolean;
  busy: boolean;
  onEdit: (editing: boolean) => void;
  onDecide: (decision: Decision) => void;
  onRevised: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const a = props.approval;
  const [subject, setSubject] = useState(a.subject ?? '');
  const [body, setBody] = useState(a.body);
  const revise = useMutation({
    mutationFn: () => call('drafts.revise', { draftId: a.draftId, subject, body }),
    onSuccess: props.onRevised,
  });
  return (
    <article aria-label={a.contactName} className="grid max-w-3xl gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[11px] text-faint">{props.position}</p>
        <p className="text-xs text-faint">{t('approvals.keys')}</p>
      </div>
      <DetailList
        items={[
          {
            label: t('approvals.to'),
            value: (
              <Link
                to={`/contacts/${a.contactId}`}
                className="hover:underline"
              >{`${a.contactName} <${a.target}>`}</Link>
            ),
          },
          {
            label: t('approvals.campaign'),
            value: (
              <Link to={`/campaigns/${a.campaignId}`} className="hover:underline">
                {a.campaignName}
              </Link>
            ),
          },
          {
            label: t('campaigns.channel'),
            value: translateKey(t, `campaigns.channels.${a.channel}`, a.channel),
          },
          { label: t('common.created'), value: formatDateTime(a.createdAt, i18n.language) },
        ]}
      />
      {props.editing ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            revise.mutate();
          }}
        >
          <Field label={t('campaigns.subject')}>
            {(id) => <Input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />}
          </Field>
          <Field label={t('campaigns.body')}>
            {(id) => (
              <textarea
                id={id}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-56 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] focus:border-accent focus:outline-none"
              />
            )}
          </Field>
          {revise.isError ? <Alert>{errorMessage(t, revise.error)}</Alert> : null}
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={revise.isPending || !body.trim()}>
              {t('approvals.saveEdit')}
            </Button>
            <Button variant="ghost" onClick={() => props.onEdit(false)} disabled={revise.isPending}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-3 rounded-md border border-rule bg-raised p-5">
          {a.subject ? <p className="font-semibold">{a.subject}</p> : null}
          <p data-testid="approval-body" className="text-[13px] whitespace-pre-wrap">
            {a.body}
          </p>
          <p className="font-mono text-[11px] text-faint">{t('approvals.version', { n: a.draftVersion })}</p>
        </div>
      )}
      {props.editing ? null : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => props.onDecide('approve')}
              disabled={props.busy}
              aria-keyshortcuts="A"
            >
              {t('approvals.approve')}
            </Button>
            <Button onClick={() => props.onEdit(true)} disabled={props.busy} aria-keyshortcuts="E">
              {t('approvals.edit')}
            </Button>
            <Button onClick={() => props.onDecide('skip')} disabled={props.busy} aria-keyshortcuts="S">
              {t('approvals.skip')}
            </Button>
            <Button
              variant="danger"
              onClick={() => props.onDecide('reject')}
              disabled={props.busy}
              aria-keyshortcuts="R"
            >
              {t('approvals.reject')}
            </Button>
          </div>
          <p className="text-xs text-faint">{t('approvals.skipHint')}</p>
        </>
      )}
    </article>
  );
}
