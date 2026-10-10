import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetupState } from '@tabreach/protocol';
import { CheckCircle2, Circle, Plus, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { Alert, Button, Loading, PageHeader } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { CreateProfile } from '../browser/BrowserPage';
import { LanguageField } from '../settings/SettingsPage';
import { AiKeySetup } from '../settings/AiSettings';
import { EmailAccounts } from '../settings/EmailAccounts';

/** Refetched when settings, accounts or profiles change (lib/live). */
const SETUP_KEY = ['setup'] as const;

export function useSetupState() {
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => call('setup.get', {}),
    // Right after launch the browser worker may still be starting: ask again until it answers.
    refetchInterval: (q) => (q.state.data && q.state.data.chrome === null ? 2_000 : false),
  });
}

/** Nothing configured and the wizard never finished: a fresh install. */
export function isFreshInstall(s: SetupState): boolean {
  return s.completedAt === null && !s.aiKeySet && s.emailAccounts === 0 && s.profiles === 0;
}

/** The app's start page: the setup on a fresh install, contacts otherwise. */
export function StartPage() {
  const setup = useSetupState();
  if (setup.isPending) return <Loading />;
  // If core cannot answer, the shell already says so; contacts is the safe default.
  return <Navigate to={setup.data && isFreshInstall(setup.data) ? '/setup' : '/contacts'} replace />;
}

/**
 * First-run setup (FR-APP-002): Chrome, the AI key, an email account and a first browser profile.
 * Every step uses the ordinary settings and can be skipped; nothing here is required to look around.
 */
export function SetupPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setup = useSetupState();
  const [creatingProfile, setCreatingProfile] = useState(false);
  const finish = useMutation({
    mutationFn: () => call('setup.complete', {}),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: SETUP_KEY });
      await navigate('/contacts');
    },
  });
  const s = setup.data;
  const done = s ? [s.chrome?.installed === true, s.aiKeySet, s.emailAccounts > 0, s.profiles > 0] : [];

  return (
    <>
      <PageHeader title={t('setup.title')} subtitle={t('setup.subtitle')} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {setup.isError ? <Alert>{errorMessage(t, setup.error)}</Alert> : null}
        {!s ? (
          setup.isPending ? (
            <Loading />
          ) : null
        ) : (
          <ol className="grid max-w-3xl gap-4" aria-label={t('setup.title')}>
            <li className="rounded-md border border-rule bg-raised p-4">
              <LanguageField />
            </li>
            <Step n={1} done={done[0]!} title={t('setup.chrome.title')} testId="setup-chrome">
              {s.chrome?.installed ? (
                <p className="text-[13px] text-soft">
                  {t('setup.chrome.found', { version: s.chrome.version ?? '?' })}
                </p>
              ) : (
                <div className="grid gap-2 text-[13px]">
                  <p className="text-soft">
                    {s.chrome ? t('setup.chrome.missing') : t('setup.chrome.checking')}
                  </p>
                  <div>
                    <Button size="sm" onClick={() => void setup.refetch()} disabled={setup.isFetching}>
                      <RefreshCw size={13} aria-hidden />
                      {t('setup.chrome.recheck')}
                    </Button>
                  </div>
                </div>
              )}
            </Step>
            <Step
              n={2}
              done={done[1]!}
              title={t('setup.ai.title')}
              hint={t('setup.ai.hint')}
              testId="setup-ai"
            >
              <AiKeySetup />
            </Step>
            <Step
              n={3}
              done={done[2]!}
              title={t('setup.email.title')}
              hint={t('setup.email.hint')}
              testId="setup-email"
            >
              <EmailAccounts />
            </Step>
            <Step
              n={4}
              done={done[3]!}
              title={t('setup.profile.title')}
              hint={t('setup.profile.hint')}
              testId="setup-profile"
            >
              {s.profiles > 0 ? (
                <p className="text-[13px] text-soft">{t('setup.profile.done', { count: s.profiles })}</p>
              ) : (
                <div>
                  <Button onClick={() => setCreatingProfile(true)}>
                    <Plus size={14} aria-hidden />
                    {t('browser.new')}
                  </Button>
                </div>
              )}
            </Step>
          </ol>
        )}
        {s ? (
          <div className="mt-6 flex max-w-3xl items-center justify-end gap-2">
            {finish.isError ? <Alert>{errorMessage(t, finish.error)}</Alert> : null}
            <span className="mr-auto text-xs text-soft">{t('setup.later')}</span>
            {done.every(Boolean) ? null : (
              <Button variant="ghost" onClick={() => finish.mutate()} disabled={finish.isPending}>
                {t('setup.skip')}
              </Button>
            )}
            <Button variant="primary" onClick={() => finish.mutate()} disabled={finish.isPending}>
              {t('setup.finish')}
            </Button>
          </div>
        ) : null}
      </div>
      {creatingProfile ? (
        <CreateProfile
          onClose={() => {
            setCreatingProfile(false);
            void qc.invalidateQueries({ queryKey: SETUP_KEY });
          }}
        />
      ) : null}
    </>
  );
}

function Step(props: {
  n: number;
  done: boolean;
  title: string;
  hint?: string;
  testId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const Icon = props.done ? CheckCircle2 : Circle;
  return (
    <li
      className="grid gap-3 rounded-md border border-rule bg-raised p-4"
      data-testid={props.testId}
      data-done={props.done}
    >
      <div className="flex items-start gap-2">
        <Icon
          size={18}
          className={props.done ? 'mt-0.5 shrink-0 text-ok' : 'mt-0.5 shrink-0 text-faint'}
          aria-label={props.done ? t('setup.stepDone') : t('setup.stepOpen')}
        />
        <div className="grid gap-0.5">
          <h2 className="text-[14px] font-semibold">
            {props.n}. {props.title}
          </h2>
          {props.hint ? <p className="text-[13px] text-soft">{props.hint}</p> : null}
        </div>
      </div>
      <div className="pl-6">{props.children}</div>
    </li>
  );
}
