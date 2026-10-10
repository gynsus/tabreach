import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uuidv7, type Campaign, type CampaignPreview, type PreviewContent } from '@tabreach/protocol';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { formatDateTime } from '../../components/Timeline';
import { Alert, Badge, Button, Field, Input, Modal } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { usePagedList } from '../../lib/lists';
import { invalidateEntities } from '../../lib/live';

/**
 * The dry run (FR-CAM-008): pick one contact and see the campaign's first action for them — the
 * message, where and when it would go, or why it would not. Nothing is stored or sent.
 * `prepare` saves unsaved edits first, so what is shown is what would be launched.
 */
export function DryRunModal(props: {
  campaign: Campaign;
  prepare: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  const { query, rows } = usePagedList('contacts.list', search);
  const run = useMutation({
    mutationFn: async (input: { contactId: string; generate: boolean }) => {
      await props.prepare();
      return call('campaigns.preview', { campaignId: props.campaign.id, ...input });
    },
  });
  const pick = (id: string) => {
    setContactId(id);
    run.mutate({ contactId: id, generate: false });
  };
  const active = rows.filter((c) => c.status === 'active');

  return (
    <Modal open wide onClose={props.onClose} title={t('campaigns.dryRun.title')} busy={run.isPending}>
      <div className="grid gap-3" data-testid="dry-run">
        <p className="text-[13px] text-soft">{t('campaigns.dryRun.intro')}</p>
        <Input
          type="search"
          aria-label={t('campaigns.searchContacts')}
          placeholder={t('campaigns.searchContacts')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        {query.isError ? <Alert>{errorMessage(t, query.error)}</Alert> : null}
        <ul
          aria-label={t('nav.contacts')}
          className="max-h-[22vh] divide-y divide-rule overflow-y-auto rounded-md border border-rule"
        >
          {active.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-3 px-3 py-1.5 text-[13px] hover:bg-sunken">
                <input
                  type="radio"
                  name="dry-run-contact"
                  checked={contactId === c.id}
                  disabled={run.isPending}
                  onChange={() => pick(c.id)}
                />
                <span className="font-medium">{c.displayName}</span>
                <span className="truncate text-faint">
                  {[c.email, c.companyName].filter(Boolean).join(' · ')}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {run.isPending ? (
          <p className="text-[13px] text-soft" role="status">
            {run.variables?.generate ? t('campaigns.dryRun.writing') : t('common.loading')}
          </p>
        ) : null}
        {run.isError ? <Alert>{errorMessage(t, run.error)}</Alert> : null}
        {run.data && !run.isPending ? (
          <PreviewResult
            preview={run.data}
            onGenerate={() => contactId && run.mutate({ contactId, generate: true })}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function PreviewResult({ preview, onGenerate }: { preview: CampaignPreview; onGenerate: () => void }) {
  const { t, i18n } = useTranslation();
  const o = preview.outcome;
  return (
    <section
      aria-label={t('campaigns.dryRun.result')}
      className="grid gap-3 rounded-md border border-rule bg-raised p-4 text-[13px]"
      data-testid="dry-run-result"
      data-kind={o.kind}
    >
      {preview.alreadyEnrolled ? <Alert tone="warn">{t('campaigns.dryRun.alreadyEnrolled')}</Alert> : null}
      {preview.conditions.length > 0 ? (
        <ul className="grid gap-1 text-soft">
          {preview.conditions.map((c) => (
            <li key={c.position}>
              {t(
                c.holds ? 'campaigns.dryRun.conditionHolds' : `campaigns.dryRun.conditionFails.${c.onFalse}`,
                {
                  n: c.position,
                },
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {o.kind === 'none' ? <p>{t('campaigns.dryRun.none')}</p> : null}
      {o.kind === 'stopped' ? (
        <div className="grid gap-1">
          <p className="font-medium text-bad">
            {t('campaigns.dryRun.stopped', { reason: t(`campaigns.stopReasons.${o.reason}`) })}
          </p>
          {o.rule ? (
            <p className="text-soft">
              {translateKey(t, `campaigns.dryRun.rules.${o.rule.replace(/\./g, '_')}`, o.rule)}
            </p>
          ) : null}
          {o.fields.length > 0 ? (
            <p className="text-soft">{t('campaigns.dryRun.missing', { fields: o.fields.join(', ') })}</p>
          ) : null}
        </div>
      ) : null}
      {o.kind === 'action' ? (
        <>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-soft">{t('campaigns.dryRun.step')}</dt>
            <dd>
              {t('campaigns.stepTitle.send_message', { n: o.position })} ·{' '}
              {t(`campaigns.channels.${o.channel}`)}
              {o.linkedinAction ? ` · ${t(`campaigns.linkedinActions.${o.linkedinAction}`)}` : ''}
            </dd>
            <dt className="text-soft">{t('campaigns.dryRun.to')}</dt>
            <dd className="break-all">{o.target}</dd>
            <dt className="text-soft">{t('campaigns.dryRun.when')}</dt>
            <dd>
              {t('campaigns.dryRun.whenValue', {
                at: formatDateTime(o.plannedAt, i18n.language),
                zone: o.timeZone,
              })}
              {o.deferredBy ? (
                <span className="block text-xs text-soft">
                  {translateKey(
                    t,
                    `campaigns.dryRun.rules.${o.deferredBy.replace(/\./g, '_')}`,
                    o.deferredBy,
                  )}
                </span>
              ) : null}
            </dd>
            <dt className="text-soft">{t('campaigns.executionMode')}</dt>
            <dd>{t(`campaigns.executionModes.${o.executionMode}`)}</dd>
          </dl>
          {o.channel === 'web_form' ? <p className="text-soft">{t('campaigns.dryRun.formNote')}</p> : null}
          <Content content={o.content} onGenerate={onGenerate} />
          <p className="text-xs text-faint">{t('campaigns.dryRun.approvalNote')}</p>
        </>
      ) : null}
    </section>
  );
}

function Content({ content: c, onGenerate }: { content: PreviewContent; onGenerate: () => void }) {
  const { t } = useTranslation();
  const generate = (label: string) => (
    <div>
      <Button size="sm" onClick={onGenerate}>
        <Sparkles size={13} aria-hidden />
        {label}
      </Button>
    </div>
  );
  switch (c.kind) {
    case 'template':
    case 'ai':
      return (
        <div className="grid gap-2">
          {c.kind === 'ai' ? <Badge tone="accent">{t('campaigns.modes.ai.name')}</Badge> : null}
          {c.subject !== null ? (
            <p>
              <span className="text-soft">{t('campaigns.subject')}: </span>
              <span className="font-medium">{c.subject}</span>
            </p>
          ) : null}
          <pre
            className="whitespace-pre-wrap rounded border border-rule bg-sunken p-3 font-sans text-[13px]"
            data-testid="dry-run-body"
          >
            {c.body}
          </pre>
          {c.kind === 'ai' && c.facts.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-soft">{t('campaigns.dryRun.facts')}</p>
              <ul className="grid gap-1 text-xs text-soft">
                {c.facts.map((f) => (
                  <li key={f.quote}>
                    {f.claim} — «{f.quote}»{f.url ? ` (${f.url})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {c.kind === 'ai' ? generate(t('campaigns.dryRun.generateAgain')) : null}
        </div>
      );
    case 'ai_not_generated':
      return (
        <div className="grid gap-2">
          <p className="text-soft">{t('campaigns.dryRun.aiNotGenerated')}</p>
          {generate(t('campaigns.dryRun.generate'))}
        </div>
      );
    case 'ai_research_running':
      return (
        <div className="grid gap-2">
          <p className="text-soft">{t('campaigns.dryRun.researchRunning')}</p>
          {generate(t('campaigns.dryRun.generateAgain'))}
        </div>
      );
    case 'ai_failed':
      return (
        <div className="grid gap-2">
          <Alert>{t('campaigns.dryRun.aiFailed', { reason: c.reason })}</Alert>
          {generate(t('campaigns.dryRun.generateAgain'))}
        </div>
      );
  }
}

/** Copies the campaign's current draft into a new draft campaign and opens it (FR-CAM-001). */
export function CloneModal(props: { campaign: Campaign; prepare: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(() => t('campaigns.clone.defaultName', { name: props.campaign.name }));
  const [key] = useState(uuidv7);
  const clone = useMutation({
    mutationFn: async () => {
      await props.prepare();
      return call('campaigns.clone', { id: props.campaign.id, name: name.trim() }, { idempotencyKey: key });
    },
    onSuccess: async (c) => {
      await invalidateEntities(qc, ['campaign', 'activity']);
      props.onClose();
      await navigate(`/campaigns/${c.id}`);
    },
  });
  return (
    <Modal
      open
      onClose={props.onClose}
      title={t('campaigns.clone.title')}
      busy={clone.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={clone.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => clone.mutate()} disabled={clone.isPending || !name.trim()}>
            {t('campaigns.clone.create')}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) clone.mutate();
        }}
      >
        <p className="text-[13px] text-soft">{t('campaigns.clone.hint')}</p>
        <Field label={t('campaigns.name')}>
          {(id) => (
            <Input id={id} value={name} maxLength={200} autoFocus onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        {clone.isError ? <Alert>{errorMessage(t, clone.error)}</Alert> : null}
      </form>
    </Modal>
  );
}
