import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormSender } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import { Alert, Field, Input, Loading, SaveBar, Select, UnsavedChangesPrompt } from '../../components/ui';
import { call, errorMessage, fieldErrors, formAlert } from '../../lib/api';
import { useDraft } from '../../lib/draft';
import { invalidateEntities } from '../../lib/live';

/** Who writes through companies' contact forms, and in which browser profile (Phase 6). */
export function FormSettings() {
  const { t } = useTranslation();
  const sender = useQuery({
    queryKey: ['settings', 'formSender'],
    queryFn: () => call('forms.sender.get', {}),
  });
  if (sender.isError) return <Alert>{errorMessage(t, sender.error)}</Alert>;
  if (!sender.data) return <Loading />;
  return <SenderForm initial={sender.data} />;
}

function SenderForm({ initial }: { initial: FormSender }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const { value, setValue, dirty, reset, saved } = useDraft(initial);
  const profiles = useQuery({
    queryKey: ['profiles', 'list'],
    queryFn: () => call('profiles.list', { includeArchived: false }),
  });
  const usable = (profiles.data?.items ?? []).filter((p) => p.purpose !== 'research');
  const save = useMutation({
    mutationFn: () => call('forms.sender.update', value),
    onSuccess: async () => {
      saved();
      toast(t('settings.forms.saved'));
      await invalidateEntities(qc, ['settings', 'activity']);
    },
  });
  const errors = fieldErrors(save.error);
  const alert = formAlert(t, save.error, ['profileId', 'name', 'email', 'phone', 'company', 'website']);
  const text = (key: 'name' | 'email' | 'phone' | 'company' | 'website', type = 'text') => (
    <Field label={t(`settings.forms.${key}`)} errorKey={errors[key]} className="max-w-md">
      {(id) => (
        <Input
          id={id}
          type={type}
          value={value[key]}
          onChange={(e) => setValue({ ...value, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  return (
    <section aria-labelledby="forms-heading" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="forms-heading" className="text-[15px] font-semibold">
          {t('settings.forms.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('settings.forms.subtitle')}</p>
      </div>
      <Field
        label={t('settings.forms.profile')}
        hint={t('settings.forms.profileHint')}
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
      {text('name')}
      {text('email', 'email')}
      {text('phone', 'tel')}
      {text('company')}
      {text('website', 'url')}
      <p className="max-w-2xl text-xs text-faint">{t('settings.forms.consentNote')}</p>
      {alert ? <Alert>{alert}</Alert> : null}
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onDiscard={reset} />
      <UnsavedChangesPrompt when={dirty && !save.isPending} />
    </section>
  );
}
