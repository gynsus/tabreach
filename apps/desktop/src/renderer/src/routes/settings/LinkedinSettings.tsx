import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LinkedinSettings as Settings } from '@tabreach/protocol';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import {
  Alert,
  Field,
  Loading,
  NumberInput,
  SaveBar,
  Select,
  UnsavedChangesPrompt,
} from '../../components/ui';
import { call, errorMessage, fieldErrors, formAlert } from '../../lib/api';
import { useDraft } from '../../lib/draft';
import { invalidateEntities } from '../../lib/live';
import { translateKey } from '../../i18n';

/**
 * The LinkedIn adapter (docs/14, FR-LIN-001…005): the risk notice, the switch, the signed-in
 * profile, `auto` per action class, and the throttles.
 */
export function LinkedinSettings() {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: ['settings', 'linkedin'],
    queryFn: () => call('linkedin.settings.get', {}),
  });
  if (settings.isError) return <Alert>{errorMessage(t, settings.error)}</Alert>;
  if (!settings.data) return <Loading />;
  return <LinkedinForm initial={settings.data} />;
}

function LinkedinForm({ initial }: { initial: Settings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const { value, setValue, dirty, reset, saved } = useDraft(initial);
  // The risk acknowledgement is not part of the settings object: its own working copy.
  const ack = useDraft(initial.riskAcknowledgedAt !== null);
  const acknowledged = ack.value;
  const setAcknowledged = ack.setValue;
  const ids = { ack: useId(), enabled: useId(), autoConnect: useId(), autoMessage: useId(), raise: useId() };
  const profiles = useQuery({
    queryKey: ['profiles', 'list'],
    queryFn: () => call('profiles.list', { includeArchived: false }),
  });
  const usable = (profiles.data?.items ?? []).filter((p) => p.purpose !== 'research');
  const save = useMutation({
    mutationFn: () =>
      call('linkedin.settings.update', {
        enabled: value.enabled,
        profileId: value.profileId,
        autoConnect: value.autoConnect,
        autoMessage: value.autoMessage,
        limits: value.limits,
        limitsRaised: value.limitsRaised,
        acknowledgeRisk: acknowledged,
      }),
    onSuccess: async () => {
      saved();
      ack.saved();
      toast(t('settings.linkedin.saved'));
      await invalidateEntities(qc, ['settings', 'activity']);
    },
  });
  const errors = fieldErrors(save.error);
  const alert = formAlert(t, save.error, ['acknowledgeRisk', 'profileId', 'limits']);
  const changed = dirty || ack.dirty;
  const box = (
    id: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    label: string,
    hint?: string,
  ) => (
    <div className="grid gap-1">
      <label htmlFor={id} className="flex items-center gap-2 text-[13px]">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
  const limit = (key: keyof Settings['limits'], max: number) => (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="w-56 text-soft">{t(`settings.linkedin.limits.${key}`)}</span>
      <NumberInput
        min={0}
        max={max}
        aria-label={t(`settings.linkedin.limits.${key}`)}
        className="w-20"
        value={value.limits[key]}
        onCommit={(n) => setValue({ ...value, limits: { ...value.limits, [key]: n } })}
      />
    </div>
  );
  return (
    <section aria-labelledby="linkedin-heading" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="linkedin-heading" className="text-[15px] font-semibold">
          {t('settings.linkedin.title')}
        </h2>
      </div>
      <Alert tone="warn">{t('settings.linkedin.risk')}</Alert>
      {box(ids.ack, acknowledged, setAcknowledged, t('settings.linkedin.acknowledge'))}
      {errors.acknowledgeRisk ? (
        <p className="text-xs text-bad">
          {translateKey(t, `errors.${errors.acknowledgeRisk}`, t('errors.generic'))}
        </p>
      ) : null}
      {box(
        ids.enabled,
        value.enabled,
        (v) => setValue({ ...value, enabled: v }),
        t('settings.linkedin.enabled'),
        t('settings.linkedin.enabledHint'),
      )}
      <Field
        label={t('settings.linkedin.profile')}
        hint={t('settings.linkedin.profileHint')}
        errorKey={errors.profileId}
        className="max-w-md"
      >
        {(id, describedBy) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={value.profileId ?? ''}
            onChange={(e) => setValue({ ...value, profileId: e.target.value || null })}
          >
            <option value="">{t('settings.forms.noProfile')}</option>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-2">
        <p className="text-xs font-medium text-soft">{t('settings.linkedin.autoTitle')}</p>
        {box(
          ids.autoConnect,
          value.autoConnect,
          (v) => setValue({ ...value, autoConnect: v }),
          t('settings.linkedin.autoConnect'),
        )}
        {box(
          ids.autoMessage,
          value.autoMessage,
          (v) => setValue({ ...value, autoMessage: v }),
          t('settings.linkedin.autoMessage'),
        )}
        <p className="text-xs text-faint">{t('settings.linkedin.autoHint')}</p>
      </div>
      <div className="grid gap-2">
        <p className="text-xs font-medium text-soft">{t('settings.linkedin.limitsTitle')}</p>
        {limit('connectPerDay', 200)}
        {limit('connectPerWeek', 1000)}
        {limit('messagePerDay', 500)}
        {box(
          ids.raise,
          value.limitsRaised,
          (v) => setValue({ ...value, limitsRaised: v }),
          t('settings.linkedin.raise'),
          t('settings.linkedin.limitsHint'),
        )}
        {errors.limits ? (
          <p className="text-xs text-bad">
            {translateKey(t, `errors.${errors.limits}`, t('errors.generic'))}
          </p>
        ) : null}
      </div>
      {alert ? <Alert>{alert}</Alert> : null}
      <SaveBar
        dirty={changed}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onDiscard={() => {
          reset();
          ack.reset();
        }}
      />
      <UnsavedChangesPrompt when={changed && !save.isPending} />
    </section>
  );
}
