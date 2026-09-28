// User-facing text lives here, separate from logic (docs/25-DEVELOPMENT-CONVENTIONS.md). English first.
export const strings = {
  title: 'System status',
  subtitle: 'Every part of TabReach runs on this Mac. This screen shows whether each one is working.',
  componentsLabel: 'Components',
  refresh: 'Refresh',
  checking: 'Checking…',
  lastChecked: (time: string) => `Checked at ${time}`,
  coreUnreachable:
    'The core process is not responding. TabReach restarts it automatically; try again in a few seconds.',
  status: { ok: 'Working', degraded: 'Needs attention', down: 'Not working', unknown: 'Unknown' },
  components: {
    core: 'Core',
    database: 'Database',
    secrets: 'Secret storage',
    worker: 'Browser worker',
    chrome: 'Google Chrome',
  },
  details: {
    sqlite: (v: string, schema: number) => `SQLite ${v} · schema version ${schema}`,
    secretsOk: 'Encrypted with the macOS Keychain',
    worker: (node: string, pw: string) => `Node ${node} · Playwright ${pw}`,
    chromeMissing: 'Not installed. Install Google Chrome to use browser features.',
    chromeUnknownVersion: 'Installed, version unknown',
    chrome: (v: string) => `Version ${v}`,
    app: (v: string, electron: string | null, node: string) =>
      `TabReach ${v}${electron ? ` · Electron ${electron}` : ''} · Node ${node}`,
  },
  launch: {
    heading: 'Chrome launch check',
    body: 'Opens Chrome with a throwaway profile, loads a page, reads its title and closes. A Chrome window will appear for a few seconds.',
    button: 'Run check',
    running: 'Running…',
    ok: (title: string, ms: number, status: number | null) =>
      `Loaded “${title}” in ${(ms / 1000).toFixed(1)} s${status ? ` (HTTP ${status})` : ''}`,
    failed: 'The check failed',
  },
} as const;
