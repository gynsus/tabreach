import { useCallback, useEffect, useState } from 'react';
import type { ComponentStatus, HealthReport, LaunchCheckResult, Problem } from '@tabreach/protocol';
import { strings } from './strings';

/** IANA-reserved example domain: a real Internet page that is safe to load. */
const LAUNCH_CHECK_URL = 'https://example.com';
const REFRESH_MS = 5_000;

interface Row {
  id: string;
  name: string;
  status: ComponentStatus;
  detail: string;
}

function rows(h: HealthReport): Row[] {
  const s = strings.components;
  const d = strings.details;
  const worker = h.worker;
  const chrome = 'chrome' in worker ? worker.chrome : null;
  return [
    {
      id: 'core',
      name: s.core,
      status: h.core.status,
      detail: d.app(h.app.version, h.app.electron, h.app.node),
    },
    {
      id: 'database',
      name: s.database,
      status: h.database.status,
      detail: h.database.sqliteVersion
        ? d.sqlite(h.database.sqliteVersion, h.database.schemaVersion)
        : (h.database.detail ?? ''),
    },
    {
      id: 'secrets',
      name: s.secrets,
      status: h.secrets.status,
      detail: h.secrets.status === 'ok' ? d.secretsOk : (h.secrets.detail ?? ''),
    },
    {
      id: 'worker',
      name: s.worker,
      status: 'chrome' in worker ? 'ok' : worker.status,
      detail: 'chrome' in worker ? d.worker(worker.node, worker.playwright) : worker.detail,
    },
    {
      id: 'chrome',
      name: s.chrome,
      status: chrome ? (chrome.installed ? 'ok' : 'down') : 'unknown',
      detail: !chrome
        ? ''
        : !chrome.installed
          ? d.chromeMissing
          : chrome.version
            ? d.chrome(chrome.version)
            : d.chromeUnknownVersion,
    },
  ];
}

export function App() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(false);
  const [launch, setLaunch] = useState<{ running: boolean; result?: LaunchCheckResult; error?: Problem }>({
    running: false,
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await window.tabreach.invoke('app.health', {});
    setLoading(false);
    if (res.ok) {
      setHealth(res.data);
      setHealthError(null);
    } else {
      setHealthError(res.error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const runLaunchCheck = async () => {
    setLaunch({ running: true });
    const res = await window.tabreach.invoke('browser.launchCheck', { url: LAUNCH_CHECK_URL });
    setLaunch(res.ok ? { running: false, result: res.data } : { running: false, error: res.error });
  };

  const chromeInstalled = health && 'chrome' in health.worker && health.worker.chrome.installed;

  return (
    <main className="page">
      <header className="masthead">
        <p className="brand">TabReach</p>
        <h1>{strings.title}</h1>
        <p className="lede">{strings.subtitle}</p>
      </header>

      <section className="panel" aria-label={strings.componentsLabel}>
        <div className="panel-head">
          <span className="meta">
            {loading && !health
              ? strings.checking
              : health
                ? strings.lastChecked(new Date(health.checkedAt).toLocaleTimeString())
                : ''}
          </span>
          <button
            type="button"
            className="button secondary"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {strings.refresh}
          </button>
        </div>

        {healthError && (
          <p className="alert" role="alert">
            {strings.coreUnreachable}
          </p>
        )}

        <ul className="components">
          {(health ? rows(health) : []).map((row) => (
            <li
              key={row.id}
              className="component"
              data-testid={`component-${row.id}`}
              data-status={row.status}
            >
              <span className={`pill ${row.status}`}>{strings.status[row.status]}</span>
              <span className="name">{row.name}</span>
              <span className="detail">{row.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="launch-heading">
        <h2 id="launch-heading">{strings.launch.heading}</h2>
        <p className="body">{strings.launch.body}</p>
        <div className="launch-row">
          <button
            type="button"
            className="button"
            onClick={() => void runLaunchCheck()}
            disabled={launch.running || !chromeInstalled}
          >
            {launch.running ? strings.launch.running : strings.launch.button}
          </button>
          <code className="url">{LAUNCH_CHECK_URL}</code>
        </div>
        <div aria-live="polite" data-testid="launch-result">
          {launch.result &&
            (launch.result.ok && launch.result.title !== null ? (
              <p className="result ok">
                {strings.launch.ok(launch.result.title, launch.result.durationMs, launch.result.httpStatus)}
                {launch.result.chromeVersion && (
                  <span className="meta"> · Chrome {launch.result.chromeVersion}</span>
                )}
              </p>
            ) : (
              <p className="result down">
                {strings.launch.failed}
                {launch.result.error ? `: ${launch.result.error}` : ''}
              </p>
            ))}
          {launch.error && (
            <p className="result down">
              {strings.launch.failed}: {launch.error.title}
              {launch.error.detail ? ` — ${launch.error.detail}` : ''}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
