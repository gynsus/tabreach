import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Approval } from '@tabreach/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  DetailList,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
} from '../../components/ui';
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
  // Selected by id, so a live refresh that reorders the queue never swaps the message on screen;
  // the position is only the fallback once it has been decided (audit 4.5).
  const [selected, setSelected] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const [editing, setEditing] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const current =
    items.find((a) => a.id === selected.id) ?? items[Math.min(selected.index, Math.max(items.length - 1, 0))];
  const select = (i: number) => {
    const next = items[Math.max(0, Math.min(i, items.length - 1))];
    if (next) setSelected({ id: next.id, index: items.indexOf(next) });
    setEditing(false);
    setConfirmReject(false);
  };

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

  // The listener is attached once, on mount, and reads the latest state through a ref: a key pressed
  // right after an approval appears must not fall between two re-attachments.
  const position = current ? items.indexOf(current) : 0;
  const latest = useRef({ current, decide, editing, confirmReject, position, select });
  latest.current = { current, decide, editing, confirmReject, position, select };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { current, decide, editing, confirmReject, position, select } = latest.current;
      if (editing || !current || decide.isPending) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'a') decide.mutate({ decision: 'approve', approval: current });
      else if (key === 's') decide.mutate({ decision: 'skip', approval: current });
      // Rejecting stops the sequence: R asks first, a second R confirms, Escape cancels.
      else if (key === 'r' && confirmReject) {
        setConfirmReject(false);
        decide.mutate({ decision: 'reject', approval: current });
      } else if (key === 'r') setConfirmReject(true);
      else if (e.key === 'Escape' && confirmReject) setConfirmReject(false);
      else if (key === 'e') setEditing(true);
      else if (key === 'j' || e.key === 'ArrowDown') select(position + 1);
      else if (key === 'k' || e.key === 'ArrowUp') select(position - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <PageHeader title={t('approvals.title')} subtitle={t('approvals.subtitle')} />
      {pending.isPending ? <Loading /> : null}
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
                  onClick={() => select(i)}
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
              confirmReject={confirmReject}
              onConfirmReject={setConfirmReject}
              onDecide={(decision) => {
                setConfirmReject(false);
                decide.mutate({ decision, approval: current });
              }}
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
  confirmReject: boolean;
  onConfirmReject: (confirming: boolean) => void;
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
          <p className="flex items-center gap-2 font-mono text-[11px] text-faint">
            {t('approvals.version', { n: a.draftVersion })}
            <Badge tone={a.origin === 'ai' ? 'accent' : 'neutral'}>
              {t(`approvals.origins.${a.origin}`)}
            </Badge>
          </p>
        </div>
      )}
      {props.editing ? null : <Checks approval={a} />}
      {props.editing || a.facts.length === 0 ? null : <FactsUsed approval={a} />}
      {props.editing || a.draftVersion < 2 ? null : <History draftId={a.draftId} />}
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
            {props.confirmReject ? (
              <span role="group" aria-label={t('approvals.confirmReject')} className="flex gap-2">
                <Button
                  variant="danger"
                  onClick={() => props.onDecide('reject')}
                  disabled={props.busy}
                  autoFocus
                >
                  {t('approvals.confirmReject')}
                </Button>
                <Button variant="ghost" onClick={() => props.onConfirmReject(false)}>
                  {t('common.cancel')}
                </Button>
              </span>
            ) : (
              <Button
                variant="danger"
                onClick={() => props.onConfirmReject(true)}
                disabled={props.busy}
                aria-keyshortcuts="R"
              >
                {t('approvals.reject')}
              </Button>
            )}
          </div>
          <p className="text-xs text-faint">{t('approvals.skipHint')}</p>
        </>
      )}
    </article>
  );
}

/** The automated draft checks for exactly this version (ADR 025). */
function Checks({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  if (a.checks.length === 0) return null;
  const failed = a.checks.filter((c) => !c.passed);
  return (
    <section aria-labelledby="checks-heading" className="grid gap-2" data-testid="draft-checks">
      <h3 id="checks-heading" className="text-xs font-semibold text-soft">
        {failed.length ? t('approvals.checksFailed', { count: failed.length }) : t('approvals.checksPassed')}
      </h3>
      <ul className="grid gap-1 text-[13px]">
        {a.checks.map((c) => (
          <li key={c.key} className="flex flex-wrap items-baseline gap-2">
            <span aria-hidden className={c.passed ? 'text-ok' : 'text-bad'}>
              {c.passed ? '✓' : '✗'}
            </span>
            <span className={c.passed ? 'text-soft' : 'font-medium'}>
              {t(`approvals.checks.${c.key}`)}
              <span className="sr-only">: {c.passed ? t('approvals.passed') : t('approvals.failed')}</span>
            </span>
            {c.detail ? <span className="text-xs text-bad [overflow-wrap:anywhere]">{c.detail}</span> : null}
          </li>
        ))}
      </ul>
      {a.origin === 'ai' && failed.some((c) => c.key === 'grounding') ? (
        <p className="text-xs text-soft">{t('approvals.groundingHint')}</p>
      ) : null}
    </section>
  );
}

/** The research facts the draft relies on, with the quote that proves each one. */
function FactsUsed({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="facts-heading" className="grid gap-2">
      <h3 id="facts-heading" className="text-xs font-semibold text-soft">
        {t('approvals.factsUsed', { count: a.facts.length })}
      </h3>
      <ul className="grid gap-2 text-[13px]">
        {a.facts.map((f) => (
          <li key={f.id} className="grid gap-0.5 border-l-2 border-accent pl-3">
            <span>{f.claim}</span>
            <span className="text-xs text-soft">{t('common.quoted', { text: f.quote })}</span>
            {f.url ? <span className="font-mono text-[11px] break-all text-faint">{f.url}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Earlier versions of this message: what AI wrote, what a person changed. */
function History({ draftId }: { draftId: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ['approvals', 'history', draftId],
    queryFn: () => call('drafts.history', { draftId }),
    enabled: open,
  });
  return (
    <section className="grid gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="justify-self-start"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? t('approvals.hideHistory') : t('approvals.showHistory')}
      </Button>
      {open && history.data ? (
        <ol className="grid gap-2">
          {history.data.items.map((v) => (
            <li key={v.id} className="grid gap-1 rounded-md border border-rule bg-sunken p-3 text-[13px]">
              <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-faint">
                {t('approvals.version', { n: v.version })}
                <Badge tone="neutral">{t(`approvals.origins.${v.origin}`)}</Badge>
                {formatDateTime(v.createdAt, i18n.language)}
              </span>
              {v.subject ? <span className="font-medium">{v.subject}</span> : null}
              <span className="whitespace-pre-wrap text-soft">{v.body}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {history.isError ? <Alert>{errorMessage(t, history.error)}</Alert> : null}
    </section>
  );
}
