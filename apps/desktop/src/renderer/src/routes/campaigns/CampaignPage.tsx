import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_POLICY, type Campaign, type CampaignConfig } from '@tabreach/protocol';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Select,
  UnsavedChangesPrompt,
} from '../../components/ui';
import { WindowEditor } from '../../components/WindowEditor';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';
import { statusTone } from './CampaignsPage';
import { Timeline } from '../../components/Timeline';
import { ApprovalSection } from './ApprovalSection';
import { CloneModal, DryRunModal } from './DryRun';
import { PeopleSection } from './PeopleSection';
import { SequenceEditor } from './SequenceEditor';

export function CampaignPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const campaign = useQuery({ queryKey: ['campaign', id], queryFn: () => call('campaigns.get', { id }) });
  if (campaign.isError) {
    return (
      <div className="p-6">
        <Alert>{errorMessage(t, campaign.error)}</Alert>
      </div>
    );
  }
  if (!campaign.data) return <p className="p-6 text-[13px] text-soft">{t('common.loading')}</p>;
  return <CampaignView key={campaign.data.id} campaign={campaign.data} />;
}

function CampaignView({ campaign }: { campaign: Campaign }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [config, setConfig] = useState<CampaignConfig>(campaign.config);
  const [dirty, setDirty] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [dialog, setDialog] = useState<'dryRun' | 'clone' | null>(null);
  const archived = campaign.status === 'archived';

  // Take the server's copy when it changes and nothing local is pending.
  useEffect(() => {
    if (!dirty) setConfig(campaign.config);
  }, [campaign.config, dirty]);

  const edit = (next: CampaignConfig) => {
    setConfig(next);
    setDirty(true);
  };
  const refresh = () => invalidateEntities(qc, ['campaign', 'enrollment', 'activity']);

  const save = useMutation({
    mutationFn: () => call('campaigns.update', { id: campaign.id, config }),
    onSuccess: async () => {
      setDirty(false);
      await refresh();
    },
  });
  const launch = useMutation({
    mutationFn: async () => {
      if (dirty) await call('campaigns.update', { id: campaign.id, config });
      return call('campaigns.launch', { id: campaign.id });
    },
    onSuccess: async (c) => {
      setDirty(false);
      toast(t('campaigns.launched', { version: c.activeVersion }));
      await refresh();
    },
  });
  const status = useMutation({
    mutationFn: (action: 'campaigns.pause' | 'campaigns.resume' | 'campaigns.archive') =>
      call(action, { id: campaign.id }),
    onSuccess: refresh,
    onError: (error) => toast(errorMessage(t, error), 'bad'),
    onSettled: () => setConfirmArchive(false),
  });
  // A dry run or a copy works from the saved draft: unsaved edits are saved first.
  const prepare = async () => {
    if (!dirty || archived) return;
    await call('campaigns.update', { id: campaign.id, config });
    setDirty(false);
    await refresh();
  };
  const errors = fieldErrors(launch.error);
  const busy = save.isPending || launch.isPending || status.isPending;
  const windowOverride = config.window !== null;

  return (
    <>
      <PageHeader
        title={campaign.name}
        subtitle={
          <span className="flex items-center gap-2">
            <Link to="/campaigns" className="hover:text-ink">
              {t('campaigns.title')}
            </Link>
            <Badge tone={statusTone[campaign.status]}>{t(`campaigns.statuses.${campaign.status}`)}</Badge>
            <span className="font-mono text-[11px] text-faint">
              {campaign.activeVersion
                ? t('campaigns.version', { version: campaign.activeVersion })
                : t('campaigns.notLaunched')}
            </span>
            {dirty ? <span className="text-xs text-warn">{t('campaigns.unsaved')}</span> : null}
          </span>
        }
        actions={
          archived ? (
            <Button onClick={() => setDialog('clone')}>{t('campaigns.clone.action')}</Button>
          ) : (
            <>
              <Button onClick={() => setDialog('dryRun')} disabled={busy}>
                {t('campaigns.dryRun.action')}
              </Button>
              <Button onClick={() => setDialog('clone')} disabled={busy}>
                {t('campaigns.clone.action')}
              </Button>
              <Button onClick={() => save.mutate()} disabled={busy || !dirty}>
                {t('campaigns.saveDraft')}
              </Button>
              <Button
                variant="primary"
                onClick={() => launch.mutate()}
                disabled={busy}
                title={campaign.activeVersion ? t('campaigns.relaunchHint') : undefined}
              >
                {campaign.activeVersion ? t('campaigns.relaunch') : t('campaigns.launch')}
              </Button>
              {campaign.status === 'active' ? (
                <Button onClick={() => status.mutate('campaigns.pause')} disabled={busy}>
                  {t('campaigns.pause')}
                </Button>
              ) : null}
              {campaign.status === 'paused' ? (
                <Button onClick={() => status.mutate('campaigns.resume')} disabled={busy}>
                  {t('campaigns.resume')}
                </Button>
              ) : null}
              {confirmArchive ? (
                <Button variant="danger" onClick={() => status.mutate('campaigns.archive')} disabled={busy}>
                  {t('campaigns.confirmArchive')}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmArchive(true)} disabled={busy}>
                  {t('campaigns.archive')}
                </Button>
              )}
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid max-w-4xl gap-8 p-6">
          {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
          {launch.isError ? (
            // Field problems are shown at their fields; the alert only points to them.
            <Alert>
              {Object.keys(errors).length > 0 ? t('errors.campaign.invalid') : errorMessage(t, launch.error)}
            </Alert>
          ) : null}

          <section aria-labelledby="sequence-heading" className="grid gap-3">
            <h2 id="sequence-heading" className="text-[15px] font-semibold">
              {t('campaigns.sequence')}
            </h2>
            <SequenceEditor
              steps={config.steps}
              onChange={(steps) => edit({ ...config, steps })}
              errors={errors}
              disabled={archived || busy}
            />
          </section>

          {config.steps.some((s) => s.type === 'send_message' && s.channel === 'email') ? (
            <SendingSection
              value={config.emailAccountId}
              errorKey={errors.emailAccountId}
              disabled={archived || busy}
              onChange={(emailAccountId) => edit({ ...config, emailAccountId })}
            />
          ) : null}

          <section aria-labelledby="schedule-heading" className="grid gap-3">
            <h2 id="schedule-heading" className="text-[15px] font-semibold">
              {t('campaigns.schedule')}
            </h2>
            <Field
              label={t('campaigns.timezone')}
              hint={t('campaigns.timezoneHint')}
              errorKey={errors.timezone}
              className="max-w-sm"
            >
              {(id, describedBy) => (
                <Input
                  id={id}
                  value={config.timezone ?? ''}
                  placeholder="Europe/Berlin"
                  disabled={archived || busy}
                  aria-describedby={describedBy}
                  aria-invalid={errors.timezone ? true : undefined}
                  onChange={(e) => edit({ ...config, timezone: e.target.value.trim() || null })}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={!windowOverride}
                disabled={archived || busy}
                onChange={(e) => edit({ ...config, window: e.target.checked ? null : DEFAULT_POLICY.window })}
              />
              {t('campaigns.useDefaultWindow')}
            </label>
            {config.window ? (
              <WindowEditor
                value={config.window}
                disabled={archived || busy}
                onChange={(window) => edit({ ...config, window })}
              />
            ) : null}
          </section>

          <ApprovalSection config={config} disabled={archived || busy} onChange={edit} />

          <UnsavedChangesPrompt when={dirty && !save.isPending && !launch.isPending} />
          <PeopleSection campaign={campaign} />

          <Timeline scope={{ campaignId: campaign.id }} refs={['contact']} />
        </div>
      </div>
      {dialog === 'dryRun' ? (
        <DryRunModal campaign={campaign} prepare={prepare} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'clone' ? (
        <CloneModal campaign={campaign} prepare={prepare} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

function SendingSection(props: {
  value: string | null;
  errorKey: string | undefined;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => call('accounts.list', {}) });
  const items = accounts.data?.items ?? [];
  return (
    <section aria-labelledby="sending-heading" className="grid gap-3">
      <h2 id="sending-heading" className="text-[15px] font-semibold">
        {t('campaigns.sending')}
      </h2>
      <Field
        label={t('campaigns.emailAccount')}
        errorKey={props.errorKey}
        hint={accounts.isSuccess && items.length === 0 ? t('campaigns.connectAccountHint') : undefined}
        className="max-w-md"
      >
        {(id, describedBy) => (
          <Select
            id={id}
            value={props.value ?? ''}
            disabled={props.disabled}
            aria-describedby={describedBy}
            aria-invalid={props.errorKey ? true : undefined}
            onChange={(e) => props.onChange(e.target.value || null)}
          >
            <option value="">{t('campaigns.noAccount')}</option>
            {items.map((a) => (
              <option key={a.id} value={a.id} disabled={a.status !== 'active'}>
                {a.fromName ? `${a.fromName} <${a.address}>` : a.address}
                {a.status === 'active' ? '' : ` — ${t(`accounts.statuses.${a.status}`)}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {accounts.isSuccess && items.length === 0 ? (
        <Link to="/settings/email" className="text-[13px] text-accent hover:underline">
          {t('accounts.connect')}
        </Link>
      ) : null}
    </section>
  );
}
