import { useMutation } from '@tanstack/react-query';
import type { Language } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { Alert, Field, PageHeader, Select } from '../../components/ui';
import { languages, setLanguage } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { EmailAccounts } from './EmailAccounts';
import { PolicySettings } from './PolicySettings';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const save = useMutation({
    mutationFn: (language: Language) => call('settings.ui.update', { language }),
    onSuccess: (s) => setLanguage(s.language),
  });
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="grid max-w-2xl content-start gap-8 overflow-y-auto p-6">
        <div className="grid max-w-md gap-4">
          <Field label={t('settings.language')} hint={t('settings.languageHint')}>
            {(id, describedBy) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={i18n.language}
                onChange={(e) => save.mutate(e.target.value as Language)}
                disabled={save.isPending}
              >
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {t(`settings.languages.${l}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
        </div>
        <EmailAccounts />
        <PolicySettings />
      </div>
    </>
  );
}
