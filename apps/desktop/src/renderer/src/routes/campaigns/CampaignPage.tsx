import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_POLICY, type Campaign, type CampaignConfig } from '@tabreach/protocol';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  NumberInput,
  PageHeader,
  Select,
  UnsavedChangesPrompt,
} from '../../components/ui';
import { Tabs } from '../../components/Tabs';
import { WindowEditor } from '../../components/WindowEditor';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';
import { statusTone } from './CampaignsPage';
import { Timeline } from '../../components/Timeline';
import { ApprovalSection } from './ApprovalSection';
import { CloneModal, DryRunModal } from './DryRun';
import { PeopleSection } from './PeopleSection';
import { SequenceEditor } from './SequenceEditor';

const TABS = ['overview', 'audience', 'sequence', 'people', 'settings'] as const;
type Tab = (typeof TABS)[number];

/** Which tab shows the field a launch error names (field keys from core's campaign validation). */
function tabOf(field: string): Tab {
  if (field.startsWith('steps')) return 'sequence';
  if (
    ['goal', 'icp', 'researchInstructions', 'researchContacts', 'aiBudgetUsd', 'researchMaxAgeDays'].includes(
      field,
    )
  )
    return 'audience';
  return 'settings';
}

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
  const navigate = useNavigate();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dialog, setDialog] = useState<'dryRun' | 'clone' | null>(null);
  const archived = campaign.status === 'archived';
  const [search, setSearch] = useSearchParams();
  const tab: Tab = TABS.includes(search.get('tab') as Tab) ? (search.get('tab') as Tab) : 'overview';
  const selectTab = (next: Tab) => setSearch(next === 'overview' ? {} : { tab: next }, { replace: true });

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
    onError: (error) => {
      const first = Object.keys(fieldErrors(error))[0];
      if (first) selectTab(tabOf(first));
    },
  });
  const status = useMutation({
    mutationFn: (action: 'campaigns.pause' | 'campaigns.resume' | 'campaigns.archive') =>
      call(action, { id: campaign.id }),
    onSuccess: refresh,
    onError: (error) => toast(errorMessage(t, error), 'bad'),
    onSettled: () => setConfirmArchive(false),
  });
  // Only a never-launched campaign can be deleted; a launched one has history and is archived.
  const neverLaunched = campaign.activeVersion === null;
  const remove = useMutation({
    mutationFn: () => call('campaigns.delete', { id: campaign.id }),
    onSuccess: async () => {
      setDirty(false);
      toast(t('campaigns.deleted'));
      await invalidateEntities(qc, ['campaign', 'activity']);
      await navigate('/campaigns');
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
    onSettled: () => setConfirmDelete(false),
  });
  const deleteButton = confirmDelete ? (
    <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
      {t('campaigns.confirmDelete')}
    </Button>
  ) : (
    <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={remove.isPending}>
      {t('campaigns.delete')}
    </Button>
  );
  // A dry run or a copy works from the saved draft: unsaved edits are saved first.
  const prepare = async () => {
    if (!dirty || archived) return;
    await call('campaigns.update', { id: campaign.id, config });
    setDirty(false);
    await refresh();
  };
  const errors = fieldErrors(launch.error);
  const busy = save.isPending || launch.isPending || status.isPending || remove.isPending;
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
            <>
              <Button onClick={() => setDialog('clone')}>{t('campaigns.clone.action')}</Button>
              {neverLaunched ? deleteButton : null}
            </>
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
              {neverLaunched ? (
                deleteButton
              ) : confirmArchive ? (
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
      <Tabs
        label={campaign.name}
        idPrefix="campaign"
        current={tab}
        onSelect={selectTab}
        markedLabel={t('campaigns.tabs.hasErrors')}
        tabs={TABS.map((id) => ({
          id,
          label: t(`campaigns.tabs.${id}`),
          marked: Object.keys(errors).some((f) => tabOf(f) === id),
        }))}
      />
      <div
        role="tabpanel"
        id={`campaign-panel-${tab}`}
        aria-labelledby={`campaign-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="grid gap-8 p-6">
          {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
          {launch.isError ? (
            // Field problems are shown at their fields; the alert only points to them.
            <Alert>
              {Object.keys(errors).length > 0 ? t('errors.campaign.invalid') : errorMessage(t, launch.error)}
            </Alert>
          ) : null}

          {tab === 'overview' ? <Overview campaign={campaign} config={config} onSelect={selectTab} /> : null}

          {tab === 'audience' ? (
            <TargetingSection
              config={config}
              spend={campaign.aiSpend}
              disabled={archived || busy}
              onChange={edit}
            />
          ) : null}

          {tab === 'sequence' ? (
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
          ) : null}

          {tab === 'people' ? <PeopleSection campaign={campaign} /> : null}

          {tab === 'settings' ? (
            <>
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
                    onChange={(e) =>
                      edit({ ...config, window: e.target.checked ? null : DEFAULT_POLICY.window })
                    }
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
            </>
          ) : null}

          <UnsavedChangesPrompt when={dirty && !save.isPending && !launch.isPending} />
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

const textarea =
  'min-h-20 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none';

/** Goal, ICP and what research looks for (docs/16 "Campaign context", docs/17). */
function TargetingSection(props: {
  config: CampaignConfig;
  spend: Campaign['aiSpend'];
  disabled: boolean;
  onChange: (config: CampaignConfig) => void;
}) {
  const { t } = useTranslation();
  const { config } = props;
  const area = (key: 'goal' | 'icp' | 'researchInstructions', max: number) => (
    <Field label={t(`campaigns.targeting.${key}`)} hint={t(`campaigns.targeting.${key}Hint`)}>
      {(id, describedBy) => (
        <textarea
          id={id}
          className={textarea}
          maxLength={max}
          value={config[key]}
          placeholder={t(`campaigns.targeting.${key}Placeholder`)}
          disabled={props.disabled}
          aria-describedby={describedBy}
          onChange={(e) => props.onChange({ ...config, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  return (
    <section aria-labelledby="targeting-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h2 id="targeting-heading" className="text-[15px] font-semibold">
          {t('campaigns.targeting.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('campaigns.targeting.subtitle')}</p>
      </div>
      {area('goal', 1_000)}
      {area('icp', 2_000)}
      {area('researchInstructions', 2_000)}
      <label className="flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={config.researchContacts}
          disabled={props.disabled}
          onChange={(e) => props.onChange({ ...config, researchContacts: e.target.checked })}
        />
        <span className="grid gap-0.5">
          {t('campaigns.targeting.researchContacts')}
          <span className="text-xs text-faint">{t('campaigns.targeting.researchContactsHint')}</span>
        </span>
      </label>
      <Field
        label={t('campaigns.targeting.budget')}
        hint={t('campaigns.targeting.budgetHint')}
        className="max-w-xs"
      >
        {(id, describedBy) => (
          <Input
            id={id}
            type="number"
            min={0}
            step="0.5"
            value={config.aiBudgetUsd ?? ''}
            disabled={props.disabled}
            aria-describedby={describedBy}
            onChange={(e) => {
              const v = e.target.value.trim();
              const n = Number(v);
              props.onChange({ ...config, aiBudgetUsd: v === '' || !Number.isFinite(n) || n < 0 ? null : n });
            }}
          />
        )}
      </Field>
      {props.spend.calls > 0 ? (
        <p className="text-xs text-soft" data-testid="campaign-ai-spend">
          {props.spend.costUsd === null
            ? t('campaigns.targeting.spendUnknown', { calls: props.spend.calls })
            : t('campaigns.targeting.spend', {
                cost: `$${props.spend.costUsd.toFixed(props.spend.costUsd < 1 ? 4 : 2)}`,
                calls: props.spend.calls,
              })}
          {props.config.aiBudgetUsd !== null ? ` / $${props.config.aiBudgetUsd}` : ''}
        </p>
      ) : null}
      <Field
        label={t('campaigns.targeting.maxAge')}
        hint={t('campaigns.targeting.maxAgeHint')}
        className="max-w-xs"
      >
        {(id, describedBy) => (
          <NumberInput
            id={id}
            min={1}
            max={365}
            value={config.researchMaxAgeDays}
            disabled={props.disabled}
            aria-describedby={describedBy}
            onCommit={(researchMaxAgeDays) => props.onChange({ ...config, researchMaxAgeDays })}
          />
        )}
      </Field>
    </section>
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

/**
 * The first tab (docs/22 9b): for a draft, what is still to set up before launch; once launched,
 * how the campaign is doing and its history.
 */
function Overview(props: { campaign: Campaign; config: CampaignConfig; onSelect: (tab: Tab) => void }) {
  const { t } = useTranslation();
  const { campaign: c, config } = props;
  const e = c.enrollments;
  const emailSteps = config.steps.some((s) => s.type === 'send_message' && s.channel === 'email');
  const setup: { tab: Tab; done: boolean; text: string }[] = [
    {
      tab: 'audience',
      done: config.goal.trim() !== '' || config.icp.trim() !== '',
      text: t('campaigns.overview.audience'),
    },
    {
      tab: 'sequence',
      done: config.steps.length > 0,
      text: t('campaigns.overview.sequence', { count: config.steps.length }),
    },
    {
      tab: 'settings',
      done: !emailSteps || config.emailAccountId !== null,
      text: emailSteps ? t('campaigns.overview.mailbox') : t('campaigns.overview.settings'),
    },
  ];
  const stats = [
    { label: t('campaigns.overview.sent'), value: c.results.sent },
    { label: t('campaigns.overview.replied'), value: c.results.replied },
    { label: t('campaigns.overview.active'), value: (e.active ?? 0) + (e.paused ?? 0) },
    { label: t('campaigns.overview.completed'), value: e.completed ?? 0 },
    { label: t('campaigns.overview.stopped'), value: e.stopped ?? 0 },
  ];
  return (
    <>
      {c.activeVersion === null ? (
        <section aria-labelledby="setup-heading" className="grid gap-3">
          <div className="grid gap-1">
            <h2 id="setup-heading" className="text-[15px] font-semibold">
              {t('campaigns.overview.setupTitle')}
            </h2>
            <p className="text-[13px] text-soft">{t('campaigns.overview.setupHint')}</p>
          </div>
          <ol className="divide-y divide-rule rounded-md border border-rule bg-raised">
            {setup.map((item) => (
              <li key={item.tab}>
                <button
                  type="button"
                  onClick={() => props.onSelect(item.tab)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-[13px] hover:bg-sunken"
                  data-testid={`setup-${item.tab}`}
                  data-done={item.done}
                >
                  <Badge tone={item.done ? 'ok' : 'neutral'}>
                    {item.done ? t('campaigns.overview.done') : t('campaigns.overview.todo')}
                  </Badge>
                  <span className="flex-1">{item.text}</span>
                  <span className="text-accent">{t(`campaigns.tabs.${item.tab}`)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <section aria-labelledby="results-heading" className="grid gap-3">
          <h2 id="results-heading" className="text-[15px] font-semibold">
            {t('campaigns.overview.resultsTitle')}
          </h2>
          <dl
            className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3"
            data-testid="campaign-results"
          >
            {stats.map((s) => (
              <div key={s.label} className="grid gap-1 rounded-md border border-rule bg-raised p-3">
                <dt className="text-xs text-soft">{s.label}</dt>
                <dd className="font-mono text-xl leading-none">{s.value}</dd>
              </div>
            ))}
          </dl>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {c.pendingApprovals ? (
              <Link to="/approvals" className="text-accent hover:underline">
                {t('campaigns.overview.toReview', { count: c.pendingApprovals })}
              </Link>
            ) : null}
            {c.outdatedEnrollments ? (
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => props.onSelect('people')}
              >
                {t('campaigns.overview.outdated', { count: c.outdatedEnrollments })}
              </button>
            ) : null}
            {c.aiSpend.calls > 0 ? (
              <span className="text-soft">
                {c.aiSpend.costUsd === null
                  ? t('campaigns.targeting.spendUnknown', { calls: c.aiSpend.calls })
                  : t('campaigns.targeting.spend', {
                      cost: `$${c.aiSpend.costUsd.toFixed(c.aiSpend.costUsd < 1 ? 4 : 2)}`,
                      calls: c.aiSpend.calls,
                    })}
              </span>
            ) : null}
          </p>
        </section>
      )}
      <Timeline scope={{ campaignId: c.id }} refs={['contact']} />
    </>
  );
}
