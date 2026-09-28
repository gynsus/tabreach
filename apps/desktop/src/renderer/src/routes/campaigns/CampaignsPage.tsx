import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Campaign, type CampaignStatus } from '@tabreach/protocol';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, EmptyState, Field, Input, Modal, PageHeader } from '../../components/ui';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

export const statusTone: Record<CampaignStatus, 'neutral' | 'ok' | 'warn' | 'accent'> = {
  draft: 'neutral',
  active: 'ok',
  paused: 'warn',
  archived: 'neutral',
};

export function CampaignsPage() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const campaigns = useQuery({
    queryKey: ['campaigns', 'list'],
    queryFn: () => call('campaigns.list', { includeArchived: false }),
  });
  const items = campaigns.data?.items ?? [];

  return (
    <>
      <PageHeader
        title={t('campaigns.title')}
        subtitle={t('campaigns.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden />
            {t('campaigns.new')}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {campaigns.isError ? <Alert>{errorMessage(t, campaigns.error)}</Alert> : null}
        {campaigns.isSuccess && items.length === 0 ? (
          <EmptyState
            title={t('campaigns.emptyTitle')}
            body={t('campaigns.emptyBody')}
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t('campaigns.new')}
              </Button>
            }
          />
        ) : null}
        {items.length > 0 ? (
          <ul
            aria-label={t('campaigns.title')}
            className="divide-y divide-rule rounded-md border border-rule bg-raised"
          >
            {items.map((c) => (
              <CampaignRow key={c.id} campaign={c} />
            ))}
          </ul>
        ) : null}
      </div>
      <CreateCampaign open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  const { t } = useTranslation();
  return (
    <li>
      <Link
        to={`/campaigns/${c.id}`}
        className="grid grid-cols-[minmax(200px,2fr)_140px_minmax(200px,2fr)_120px] items-center gap-4 px-4 py-3 text-[13px] hover:bg-sunken"
      >
        <span className="grid gap-0.5">
          <span className="font-medium">{c.name}</span>
          <span className="font-mono text-[11px] text-faint">
            {c.activeVersion
              ? t('campaigns.version', { version: c.activeVersion })
              : t('campaigns.notLaunched')}
          </span>
        </span>
        <span>
          <Badge tone={statusTone[c.status]}>{t(`campaigns.statuses.${c.status}`)}</Badge>
        </span>
        <span className="text-soft">{t('campaigns.counts', c.enrollments)}</span>
        <span>
          {c.pendingApprovals > 0 ? (
            <Badge tone="accent">
              {c.pendingApprovals} · {t('campaigns.columns.approvals')}
            </Badge>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function CreateCampaign(props: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState(uuidv7);
  const create = useMutation({
    mutationFn: () => call('campaigns.create', { name }, { idempotencyKey: key }),
    onSuccess: async (c) => {
      await invalidateEntities(qc, ['campaign']);
      setName('');
      setKey(uuidv7());
      props.onClose();
      await navigate(`/campaigns/${c.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  const errors = fieldErrors(create.error);
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={t('campaigns.new')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="create-campaign"
            disabled={create.isPending || !name.trim()}
          >
            {t('campaigns.create')}
          </Button>
        </>
      }
    >
      <form id="create-campaign" onSubmit={submit} className="grid gap-3">
        <Field label={t('campaigns.name')} errorKey={errors.name}>
          {(id, describedBy) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-describedby={describedBy}
              autoFocus
            />
          )}
        </Field>
        {create.isError && !errors.name ? <Alert>{errorMessage(t, create.error)}</Alert> : null}
      </form>
    </Modal>
  );
}
