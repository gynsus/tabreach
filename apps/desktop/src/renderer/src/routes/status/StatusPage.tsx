import { useMutation, useQuery } from '@tanstack/react-query';
import type { ComponentStatus, HealthReport } from '@tabreach/protocol';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, PageHeader } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';

/** IANA-reserved example domain: a real Internet page that is safe to load. */
const LAUNCH_CHECK_URL = 'https://example.com';
const REFRESH_MS = 5_000;

const tone = { ok: 'ok', degraded: 'warn', down: 'bad', unknown: 'neutral' } as const;

/** Core reports component problems as keys (`worker.notRunning`); show them in the UI language. */
function detailText(t: TFunction, key: string | undefined): string {
  return key ? translateKey(t, `status.detailKeys.${key}`, key) : '';
}

function rows(t: TFunction, h: HealthReport): { id: string; status: ComponentStatus; detail: string }[] {
  const worker = h.worker;
  const chrome = 'chrome' in worker ? worker.chrome : null;
  return [
    {
      id: 'core',
      status: h.core.status,
      detail: t('status.details.app', {
        version: h.app.version,
        electron: h.app.electron ?? '—',
        node: h.app.node,
      }),
    },
    {
      id: 'database',
      status: h.database.status,
      detail: h.database.sqliteVersion
        ? t('status.details.sqlite', { version: h.database.sqliteVersion, schema: h.database.schemaVersion })
        : detailText(t, h.database.detail),
    },
    {
      id: 'secrets',
      status: h.secrets.status,
      detail: h.secrets.status === 'ok' ? t('status.details.secretsOk') : detailText(t, h.secrets.detail),
    },
    {
      id: 'worker',
      status: 'chrome' in worker ? 'ok' : worker.status,
      detail:
        'chrome' in worker
          ? t('status.details.worker', { node: worker.node, playwright: worker.playwright })
          : detailText(t, worker.detail),
    },
    {
      id: 'chrome',
      status: chrome ? (chrome.installed ? 'ok' : 'down') : 'unknown',
      detail: !chrome
        ? ''
        : !chrome.installed
          ? t('status.details.chromeMissing')
          : chrome.version
            ? t('status.details.chrome', { version: chrome.version })
            : t('status.details.chromeUnknownVersion'),
    },
  ];
}

export function StatusPage() {
  const { t, i18n } = useTranslation();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => call('app.health', {}),
    refetchInterval: REFRESH_MS,
  });
  const launch = useMutation({ mutationFn: () => call('browser.launchCheck', { url: LAUNCH_CHECK_URL }) });
  const h = health.data;
  const chromeInstalled = h && 'chrome' in h.worker && h.worker.chrome.installed;

  return (
    <>
      <PageHeader
        title={t('status.title')}
        subtitle={t('status.subtitle')}
        actions={
          <>
            <span className="text-xs text-faint tabular-nums">
              {h
                ? t('status.lastChecked', {
                    time: new Date(h.checkedAt).toLocaleTimeString(i18n.language),
                  })
                : t('status.checking')}
            </span>
            <Button onClick={() => void health.refetch()} disabled={health.isFetching}>
              {t('status.refresh')}
            </Button>
          </>
        }
      />
      <div className="grid max-w-3xl content-start gap-6 overflow-y-auto p-6">
        {health.isError ? <Alert tone="warn">{errorMessage(t, health.error)}</Alert> : null}
        <ul
          className="divide-y divide-rule rounded-md border border-rule bg-raised"
          aria-label={t('status.title')}
        >
          {(h ? rows(t, h) : []).map((row) => (
            <li
              key={row.id}
              data-testid={`component-${row.id}`}
              data-status={row.status}
              className="grid grid-cols-[130px_160px_1fr] items-center gap-3 px-4 py-2.5 text-[13px]"
            >
              <Badge tone={tone[row.status]} className="justify-self-start">
                {t(`status.states.${row.status}`)}
              </Badge>
              <span className="font-medium">{t(`status.components.${row.id as 'core'}`)}</span>
              <span className="text-soft [overflow-wrap:anywhere]">{row.detail}</span>
            </li>
          ))}
        </ul>

        <section
          className="grid gap-3 rounded-md border border-rule bg-raised p-4"
          aria-labelledby="launch-heading"
        >
          <h2 id="launch-heading" className="text-[14px] font-semibold">
            {t('status.launch.heading')}
          </h2>
          <p className="text-[13px] text-soft">{t('status.launch.body')}</p>
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              onClick={() => launch.mutate()}
              disabled={launch.isPending || !chromeInstalled}
            >
              {launch.isPending ? t('status.launch.running') : t('status.launch.button')}
            </Button>
            <code className="font-mono text-xs text-faint">{LAUNCH_CHECK_URL}</code>
          </div>
          <div aria-live="polite" data-testid="launch-result">
            {launch.data ? (
              launch.data.ok && launch.data.title !== null ? (
                <Alert tone="ok">
                  {t('status.launch.ok', {
                    title: launch.data.title,
                    seconds: (launch.data.durationMs / 1000).toFixed(1),
                  })}
                  {launch.data.chromeVersion ? ` · Chrome ${launch.data.chromeVersion}` : ''}
                </Alert>
              ) : (
                <Alert>
                  {t('status.launch.failed')}
                  {launch.data.error ? `: ${launch.data.error}` : ''}
                </Alert>
              )
            ) : null}
            {launch.isError ? (
              <Alert>
                {t('status.launch.failed')}: {errorMessage(t, launch.error)}
              </Alert>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
