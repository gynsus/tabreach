import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RetentionReport, RetentionSettings } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Field, Loading, SaveBar, Select, UnsavedChangesPrompt } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { useDraft } from '../../lib/draft';
import { invalidateEntities } from '../../lib/live';
import { BackupsSection } from './Backups';

const KINDS = ['screenshots', 'browserDiagnostics', 'messageBodies', 'researchEvidence', 'logs'] as const;
/** The choices offered; `keep` is null in the settings. */
const CHOICES = ['7', '30', '90', '180', '365', 'keep'] as const;

/** Data retention (docs/18) and backups (FR-APP-005): what is kept on this Mac, and copies of it. */
export function DataSettings() {
  const { t } = useTranslation();
  const state = useQuery({ queryKey: ['settings', 'retention'], queryFn: () => call('retention.get', {}) });
  if (state.isError) return <Alert>{errorMessage(t, state.error)}</Alert>;
  if (!state.data) return <Loading />;
  return (
    <div className="grid gap-8">
      <RetentionForm initial={state.data.settings} lastRun={state.data.lastRun} />
      <BackupsSection />
    </div>
  );
}

function RetentionForm({
  initial,
  lastRun,
}: {
  initial: RetentionSettings;
  lastRun: RetentionReport | null;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const { value, setValue, dirty, reset, saved } = useDraft(initial);
  const save = useMutation({
    mutationFn: () => call('retention.update', value),
    onSuccess: async () => {
      saved();
      toast(t('settings.data.saved'));
      await invalidateEntities(qc, ['settings', 'activity']);
    },
  });
  return (
    <section aria-labelledby="data-heading" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="data-heading" className="text-[15px] font-semibold">
          {t('settings.data.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('settings.data.subtitle')}</p>
      </div>
      {KINDS.map((kind) => (
        <Field
          key={kind}
          label={t(`settings.data.kinds.${kind}`)}
          hint={t(`settings.data.hints.${kind}`)}
          className="max-w-md"
        >
          {(id, describedBy) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={value[kind] === null ? 'keep' : String(value[kind])}
              onChange={(e) =>
                setValue({ ...value, [kind]: e.target.value === 'keep' ? null : Number(e.target.value) })
              }
            >
              {/* A value set outside these choices is still shown as it is. */}
              {value[kind] !== null && !CHOICES.includes(String(value[kind]) as (typeof CHOICES)[number]) ? (
                <option value={String(value[kind])}>{t('settings.data.days', { count: value[kind] })}</option>
              ) : null}
              {CHOICES.map((c) => (
                <option key={c} value={c}>
                  {c === 'keep' ? t('settings.data.keep') : t('settings.data.days', { count: Number(c) })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ))}
      <p className="text-xs text-faint">{t('settings.data.always')}</p>
      <p className="text-xs text-soft" data-testid="retention-last-run">
        {lastRun
          ? t('settings.data.lastRun', {
              at: formatDateTime(lastRun.ranAt, i18n.language),
              count:
                lastRun.screenshots +
                lastRun.browserDiagnostics +
                lastRun.messageBodies +
                lastRun.researchEvidence +
                lastRun.logs,
            })
          : t('settings.data.notYet')}
      </p>
      {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onDiscard={reset} />
      <UnsavedChangesPrompt when={dirty && !save.isPending} />
    </section>
  );
}
