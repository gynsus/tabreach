import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PolicySettings as Policy } from '@tabreach/protocol';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import { Alert, Loading, NumberInput, SaveBar, UnsavedChangesPrompt } from '../../components/ui';
import { WindowEditor } from '../../components/WindowEditor';
import { call, errorMessage } from '../../lib/api';
import { useDraft } from '../../lib/draft';
import { invalidateEntities } from '../../lib/live';

/** Contact policy (ADR 021 §6): caps across all campaigns, default sending hours, company stop. */
export function PolicySettings() {
  const { t } = useTranslation();
  const policy = useQuery({
    queryKey: ['settings', 'policy'],
    queryFn: () => call('policy.settings.get', {}),
  });
  if (policy.isError) return <Alert>{errorMessage(t, policy.error)}</Alert>;
  if (!policy.data) return <Loading />;
  return <PolicyForm initial={policy.data} />;
}

function PolicyForm({ initial }: { initial: Policy }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const { value, setValue, dirty, reset, saved } = useDraft(initial);
  const stopId = useId();
  const save = useMutation({
    mutationFn: () => call('policy.settings.update', value),
    onSuccess: async () => {
      saved();
      toast(t('settings.policy.saved'));
      await invalidateEntities(qc, ['settings', 'activity']);
    },
  });
  const cap = (which: 'contactCap' | 'companyCap') => (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="w-48 text-soft">{t(`settings.policy.${which}`)}</span>
      <NumberInput
        min={1}
        max={100}
        aria-label={`${t(`settings.policy.${which}`)}`}
        className="w-20"
        value={value[which].touches}
        onCommit={(touches) => setValue({ ...value, [which]: { ...value[which], touches } })}
      />
      <span className="text-soft">{t('settings.policy.per')}</span>
      <NumberInput
        min={1}
        max={365}
        aria-label={`${t(`settings.policy.${which}`)} · ${t('settings.policy.days')}`}
        className="w-20"
        value={value[which].days}
        onCommit={(days) => setValue({ ...value, [which]: { ...value[which], days } })}
      />
      <span className="text-soft">{t('settings.policy.days')}</span>
    </div>
  );
  return (
    <section aria-labelledby="policy-heading" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="policy-heading" className="text-[15px] font-semibold">
          {t('settings.policy.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('settings.policy.subtitle')}</p>
      </div>
      {cap('contactCap')}
      {cap('companyCap')}
      <div className="grid gap-2">
        <p className="text-xs font-medium text-soft">{t('settings.policy.window')}</p>
        <WindowEditor value={value.window} onChange={(window) => setValue({ ...value, window })} />
      </div>
      <div className="grid gap-1">
        <label htmlFor={stopId} className="flex items-center gap-2 text-[13px]">
          <input
            id={stopId}
            type="checkbox"
            checked={value.companyStopOnReply}
            onChange={(e) => setValue({ ...value, companyStopOnReply: e.target.checked })}
          />
          {t('settings.policy.companyStop')}
        </label>
        <p className="text-xs text-faint">{t('settings.policy.companyStopHint')}</p>
      </div>
      {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        invalid={value.window.start >= value.window.end}
        onSave={() => save.mutate()}
        onDiscard={reset}
      />
      <UnsavedChangesPrompt when={dirty && !save.isPending} />
    </section>
  );
}
