import { useMutation } from '@tanstack/react-query';
import type { Language } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Alert, Field, PageHeader, Select } from '../../components/ui';
import { languages, setLanguage } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { AiSettings } from './AiSettings';
import { EmailAccounts } from './EmailAccounts';
import { PolicySettings } from './PolicySettings';

const TABS = ['general', 'email', 'ai', 'policy'] as const;
type Tab = (typeof TABS)[number];

/** Settings, one logical group per tab; each tab has its own address (#/settings/ai). */
export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tab } = useParams();
  if (!TABS.includes(tab as Tab)) return <Navigate to="/settings/general" replace />;
  const current = tab as Tab;
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div role="tablist" aria-label={t('settings.title')} className="flex gap-1 border-b border-rule px-6">
        {TABS.map((id) => (
          <button
            key={id}
            id={`settings-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={current === id}
            aria-controls={`settings-panel-${id}`}
            tabIndex={current === id ? 0 : -1}
            onClick={() => void navigate(`/settings/${id}`)}
            onKeyDown={(e) => {
              // Arrow keys move between tabs (WAI-ARIA tabs pattern).
              const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = TABS[(TABS.indexOf(current) + step + TABS.length) % TABS.length]!;
              void navigate(`/settings/${next}`);
              requestAnimationFrame(() => document.getElementById(`settings-tab-${next}`)?.focus());
            }}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[13px]',
              current === id
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-soft hover:text-ink',
            )}
          >
            {t(`settings.tabs.${id}`)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`settings-panel-${current}`}
        aria-labelledby={`settings-tab-${current}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="grid max-w-3xl content-start gap-8 p-6">
          {current === 'general' ? <General /> : null}
          {current === 'email' ? <EmailAccounts /> : null}
          {current === 'ai' ? <AiSettings /> : null}
          {current === 'policy' ? <PolicySettings /> : null}
        </div>
      </div>
    </>
  );
}

function General() {
  const { t, i18n } = useTranslation();
  const save = useMutation({
    mutationFn: (language: Language) => call('settings.ui.update', { language }),
    onSuccess: (s) => setLanguage(s.language),
  });
  return (
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
  );
}
