import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';

// E2E of the built app (out/): real core, database, worker and Chrome; renderer driven like a user.
let app: ElectronApplication;
let page: Page;
let userData: string;
let fixtures: FixtureServer;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'tabreach-e2e-'));
  fixtures = await startFixtureServer();
  app = await electron.launch({
    args: [join(import.meta.dirname, '..')],
    env: { ...process.env, TABREACH_USER_DATA_DIR: userData, TABREACH_ALLOW_LOCAL_SITES: '1' },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await fixtures?.close();
  rmSync(userData, { recursive: true, force: true });
});

/** Chrome windows opened by a test take the focus; the app window gets it back. */
const focusApp = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.show();
    win?.focus();
  });

const go = (path: string) => page.evaluate((p) => (window.location.hash = p), path);

/**
 * The window itself never scrolls, only a page's own area does: a scrolled window leaves a blank
 * strip under the app. Checked with every inner area scrolled to its end, after every test and
 * on long pages.
 */
async function expectWindowNotScrollable() {
  const overflow = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*'))
      if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    const doc = document.scrollingElement as HTMLElement;
    return { vertical: doc.scrollHeight - doc.clientHeight, horizontal: doc.scrollWidth - doc.clientWidth };
  });
  expect(overflow).toEqual({ vertical: 0, horizontal: 0 });
}

/** The smallest window the app allows, where long pages overflow first. */
async function atMinimumWindowSize(check: () => Promise<void>) {
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 600));
  try {
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(600);
    await check();
  } finally {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h),
      size as [number, number],
    );
  }
}
test.afterEach(() => atMinimumWindowSize(expectWindowNotScrollable));

/** Data rows of a table (the header row has no cells). */
const dataRows = (table: string) =>
  page
    .getByRole('table', { name: table })
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });

test('a fresh install opens the first-run setup; skipping it lands on contacts for good', async () => {
  // Cold start on CI: the first paint waits up to 3 s for the saved language.
  await expect(page.getByRole('heading', { name: 'Set up TabReach' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('setup-chrome')).toHaveAttribute('data-done', 'true', { timeout: 20_000 });
  for (const step of ['setup-ai', 'setup-email', 'setup-profile'])
    await expect(page.getByTestId(step)).toHaveAttribute('data-done', 'false');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/#\/contacts$/);
  await go('#/');
  await expect(page).toHaveURL(/#\/contacts$/);
});

test('status screen shows core, database, secret storage and worker working', async () => {
  await go('#/status');
  // Cold start on CI: the first paint waits up to 3 s for the saved language.
  await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible({ timeout: 15_000 });
  for (const id of ['core', 'database', 'secrets', 'worker', 'chrome']) {
    await expect(page.getByTestId(`component-${id}`)).toHaveAttribute('data-status', 'ok', {
      timeout: 20_000,
    });
  }
  await expect(page.getByTestId('component-database')).toContainText(/schema version \d+/);
  // Adapter pack health is on the status screen (FR-LIN-006); a fresh app has no browser work yet.
  await expect(page.getByTestId('pack-health')).toContainText('No browser work in the last 30 days.');
});

test('renderer has no Node access and cannot reach host or browser channels', async () => {
  const probe = await page.evaluate(async () => {
    const bridge = (window as unknown as { tabreach: unknown }).tabreach as {
      invoke(type: string, payload: unknown): Promise<{ ok: boolean; error?: { code: string } }>;
    };
    const secret = await bridge.invoke('secret.decrypt', { ciphertext: 'AAAA' });
    const worker = await bridge.invoke('worker.launchCheck', { url: 'https://example.com' });
    return {
      hasRequire: typeof (globalThis as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (globalThis as { process?: unknown }).process !== 'undefined',
      secret: secret.error?.code,
      worker: worker.error?.code,
    };
  });
  expect(probe).toEqual({
    hasRequire: false,
    hasProcess: false,
    secret: 'UNKNOWN_MESSAGE_TYPE',
    worker: 'UNKNOWN_MESSAGE_TYPE',
  });
});

test('launch check travels renderer -> core -> worker -> Chrome and back', async () => {
  const result = await page.evaluate(async (url) => {
    const bridge = (window as unknown as { tabreach: { invoke(t: string, p: unknown): Promise<unknown> } })
      .tabreach;
    return bridge.invoke('browser.launchCheck', { url });
  }, fixtures.url);
  expect(result).toMatchObject({
    ok: true,
    data: { ok: true, httpStatus: 200, title: 'TabReach Fixture Home' },
  });
});

const csvPath = () => {
  const file = join(userData, 'prospects.csv');
  writeFileSync(
    file,
    [
      'Company;Website;First name;Last name;Email;Title',
      'Acme;acme.com;Jane;Doe;jane@acme.com;CEO',
      'Acme;acme.com;John;Roe;john@acme.com;CTO',
      'Ромашка;romashka.ru;Иван;Петров;ivan@romashka.ru;Директор',
      'Broken;;;;not-an-email;',
    ].join('\n'),
  );
  return file;
};

async function importCsv(file: string) {
  await go('#/contacts');
  await page.getByRole('button', { name: 'Import CSV' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import prospects' });
  await dialog.getByLabel('Choose a CSV file').setInputFiles(file);
  await expect(dialog.getByLabel('Import as: Email')).toHaveValue('contact.email');
  await dialog.getByRole('button', { name: 'Import 4 rows' }).click();
  const report = dialog.getByTestId('import-report');
  await expect(report).toBeVisible();
  return { dialog, report };
}

test('imports a CSV through the wizard and reports the invalid row', async () => {
  const { dialog, report } = await importCsv(csvPath());
  await expect(report).toContainText('New');
  await expect(report).toContainText('Row 5');
  await expect(report).toContainText('Enter a valid email address.');
  await dialog.getByRole('button', { name: 'Close' }).last().click();

  await expect(dataRows('Contacts')).toHaveCount(3);
  await page.getByRole('searchbox', { name: /Search by name/ }).fill('иван');
  await expect(dataRows('Contacts')).toHaveCount(1);
});

test('importing the same file again changes nothing', async () => {
  const { dialog, report } = await importCsv(csvPath());
  const cells = report.locator('dd');
  await expect(cells.nth(0)).toHaveText('0'); // new
  await expect(cells.nth(1)).toHaveText('0'); // updated
  await expect(cells.nth(2)).toHaveText('3'); // unchanged
  await dialog.getByRole('button', { name: 'Close' }).last().click();
});

test('shows a field error for a duplicate email and saves a valid contact', async () => {
  await go('#/contacts');
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await dialog.getByLabel('Full name').fill('Jane Again');
  await dialog.getByLabel('Email').fill('JANE@acme.com');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Another contact already has this email.')).toBeVisible();

  await dialog.getByLabel('Email').fill('jane.again@acme.com');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Jane Again' })).toBeVisible();
  await expect(page.getByText('Contact created')).toBeVisible();
});

test('adds a domain to the do-not-contact list', async () => {
  await go('#/suppressions');
  await page.getByLabel('Type').selectOption('domain');
  await page.getByLabel('Value').fill('https://www.Example.org/');
  await page.getByRole('button', { name: 'Add to list' }).click();
  await expect(page.getByRole('list', { name: 'Do not contact' })).toContainText('example.org');
});

test('picks a company with the keyboard: Enter chooses the first match', async () => {
  await go('#/contacts');
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'New contact' });
  await dialog.getByLabel('Full name').fill('Picker Person');
  const picker = dialog.getByRole('combobox', { name: 'Company' });
  await picker.fill('Acm');
  await expect(dialog.getByRole('option', { name: 'Acme' })).toBeVisible();
  await picker.press('Enter');
  await expect(picker).toHaveValue('Acme');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Picker Person' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Acme' })).toBeVisible();
});

test('says so when core crashes and recovers with data', async () => {
  await go('#/contacts');
  await page.getByRole('searchbox', { name: /Search by name/ }).fill('');
  await expect(dataRows('Contacts')).not.toHaveCount(0);
  const pid = await app.evaluate(
    ({ app: electronApp }) =>
      electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'TabReach core')?.pid,
  );
  expect(pid).toBeTruthy();
  process.kill(pid as number, 'SIGKILL');
  await expect(page.getByTestId('core-banner')).toBeVisible();
  await expect(page.getByTestId('core-banner')).toBeHidden({ timeout: 20_000 });
  await expect(dataRows('Contacts')).not.toHaveCount(0);
});

test('runs a campaign on the test channel: launch, add a contact, approve with the keyboard', async () => {
  await go('#/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  const create = page.getByRole('dialog', { name: 'New campaign' });
  await create.getByLabel('Name').fill('E2E campaign');
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'E2E campaign' })).toBeVisible();

  // An empty campaign cannot be launched, and says why.
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Fix the highlighted fields before launching.');
  await expect(page.getByText('Add at least one step.')).toBeVisible();

  await page.getByRole('button', { name: 'Add message' }).click();
  const step = page.getByRole('region', { name: 'Message 1' });
  await step.getByLabel('Channel').selectOption('test');
  await step.getByLabel('Subject', { exact: true }).fill('Hello {{firstName|there}}');
  await step.getByLabel('Message', { exact: true }).fill('Hi {{firstName|there}}, this is a test.');
  // An AI step needs instructions and an AI key; this run has neither, and says so at the step.
  await step.getByRole('radio', { name: /Written by AI/ }).check();
  await expect(step.getByLabel('Instructions for AI')).toBeVisible();
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(step.getByText('Write instructions for AI.')).toBeVisible();
  await expect(step.getByText(/AI messages need an AI key/)).toBeVisible();
  await step.getByRole('radio', { name: /Template/ }).check();
  await expect(step.getByLabel('Message', { exact: true })).toHaveValue(
    'Hi {{firstName|there}}, this is a test.',
  );
  await page.getByLabel('Approval', { exact: true }).selectOption('approve_campaign');
  await expect(page.getByText(/You approve the first 5 messages yourself/)).toBeVisible();
  await page.getByLabel('Approval', { exact: true }).selectOption('approve_each');
  // A number is checked when typing is done, not on every key: 2000 can be typed over 1500.
  await page.getByLabel('Maximum length, characters').fill('2000');
  await page.getByLabel('Maximum length, characters').blur();
  await expect(page.getByLabel('Maximum length, characters')).toHaveValue('2000');
  await page.getByLabel('Maximum length, characters').fill('5');
  await page.getByLabel('Maximum length, characters').press('Enter');
  await expect(page.getByLabel('Maximum length, characters')).toHaveValue('100');
  // Any day and hour, so the test does not depend on when CI runs.
  await page.getByLabel('Fallback time zone').fill('UTC');
  await page.getByLabel('Use the default sending hours from Settings').uncheck();
  await page.getByRole('button', { name: 'Sat' }).click();
  await page.getByRole('button', { name: 'Sun' }).click();
  await page.getByLabel('From', { exact: true }).fill('00:00');
  await page.getByLabel('Until', { exact: true }).fill('23:59');
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Campaign launched: version 1' })).toBeVisible();

  await page.getByRole('button', { name: 'Add contacts' }).click();
  const add = page.getByRole('dialog', { name: 'Add contacts' });
  await add.getByRole('searchbox', { name: 'Search contacts' }).fill('jane.again');
  await add.getByRole('checkbox').first().check();
  await add.getByRole('button', { name: 'Add 1 contact' }).click();
  await expect(page.getByTestId('enrollment')).toHaveCount(1);

  await go('#/approvals');
  await expect(page.getByTestId('approval-body')).toHaveText('Hi there, this is a test.', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('draft-checks')).toContainText('All checks passed');
  await atMinimumWindowSize(expectWindowNotScrollable);
  // Focus something in the queue first: on CI the window may not have OS focus, and a bare
  // keyboard.press then reaches no element. The shortcut handler itself is what is tested.
  await page.getByRole('button', { name: 'Approve' }).press('a');
  await expect(page.getByText('Nothing to approve')).toBeVisible();

  await page.getByRole('link', { name: 'Campaigns' }).click();
  await page.getByRole('link', { name: /E2E campaign/ }).click();
  await expect(page.getByTestId('enrollment')).toHaveAttribute('data-status', 'completed', {
    timeout: 15_000,
  });
  // The campaign's history names the contact; the activity log says who got what, and shows it.
  await expect(page.getByTestId('timeline').getByRole('link', { name: 'Jane Again' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  const sent = page.getByRole('listitem').filter({ hasText: 'Message sent' }).first();
  await expect(sent.getByRole('link', { name: 'Jane Again' })).toBeVisible();
  await expect(sent.getByRole('link', { name: 'E2E campaign' })).toBeVisible();
  await sent.getByRole('button', { name: /Show the message/ }).click();
  await expect(sent.getByTestId('activity-message')).toHaveText('Hi there, this is a test.');
  await expect(page.getByRole('listitem').filter({ hasText: 'Campaign launched' })).toHaveCount(0);
});

test('a dry run shows the first message for one contact without sending; a copy is a new draft', async () => {
  await go('#/campaigns');
  await page.getByRole('link', { name: /E2E campaign/ }).click();
  // Jane is in the campaign from the test before; the dry run adds no one.
  await expect(page.getByTestId('enrollment')).toHaveCount(1);

  await page.getByRole('button', { name: 'Dry run' }).click();
  const dryRun = page.getByRole('dialog', { name: 'Dry run' });
  await dryRun.getByRole('searchbox', { name: 'Search contacts' }).fill('jane.again');
  await dryRun.getByRole('radio').first().check();
  const result = dryRun.getByTestId('dry-run-result');
  await expect(result).toHaveAttribute('data-kind', 'action');
  // The same text the approval showed: this contact has no first name, so the default is used.
  await expect(result.getByTestId('dry-run-body')).toHaveText('Hi there, this is a test.');
  await expect(result).toContainText('Hello there');
  await expect(result).toContainText('jane.again@');
  await expect(result.getByRole('alert')).toContainText('already in the campaign');
  await dryRun.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('enrollment')).toHaveCount(1);

  // The status export for a CRM: the save dialog is answered with a temporary path.
  const csvPath = join(userData, 'campaign-status.csv');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
  }, csvPath);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByText('Exported 1 row')).toBeVisible();
  const lines = readFileSync(csvPath, 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
  expect(lines[0]).toMatch(/^campaign,campaign_version,first_name,/);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('E2E campaign');
  expect(lines[1]).toContain('jane.again@');

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const copy = page.getByRole('dialog', { name: 'Copy campaign' });
  await expect(copy.getByLabel('Name')).toHaveValue('E2E campaign (copy)');
  await copy.getByRole('button', { name: 'Create copy' }).click();
  await expect(page.getByRole('heading', { name: 'E2E campaign (copy)' })).toBeVisible();
  await expect(page.getByText('not launched')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Message 1' }).getByLabel('Message', { exact: true }),
  ).toHaveValue('Hi {{firstName|there}}, this is a test.');
  await expect(page.getByTestId('enrollment')).toHaveCount(0);

  // A copy that was never launched can be deleted; there is nothing to archive.
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete this campaign for good?' }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E campaign \(copy\)/ })).toHaveCount(0);

  // A launched campaign is only archived; the archive is one switch away on the list.
  await page.getByRole('link', { name: /E2E campaign/ }).click();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Archive? Sequences in progress stop.' }).click();
  await expect(page.getByText('Archived', { exact: true })).toBeVisible();
  await go('#/campaigns');
  await expect(page.getByRole('link', { name: /E2E campaign/ })).toHaveCount(0);
  await page.getByLabel('Show archived').check();
  await expect(page.getByRole('link', { name: /E2E campaign/ })).toContainText('Archived');
});

test('connecting an email account fills in known servers and reports a wrong server', async () => {
  await go('#/settings/email');
  await page.getByRole('button', { name: 'Connect an account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect an email account' });
  await dialog.getByLabel('Email address').fill('someone@gmail.com');
  await expect(dialog.getByRole('group', { name: 'Outgoing mail (SMTP)' }).getByLabel('Server')).toHaveValue(
    'smtp.gmail.com',
  );
  await expect(dialog.getByRole('group', { name: 'Incoming mail (IMAP)' }).getByLabel('Server')).toHaveValue(
    'imap.gmail.com',
  );
  // A server that does not exist: nothing is saved, the fields say why.
  await dialog.getByRole('group', { name: 'Outgoing mail (SMTP)' }).getByLabel('Server').fill('127.0.0.1');
  await dialog.getByRole('group', { name: 'Outgoing mail (SMTP)' }).getByLabel('Port').fill('1');
  await dialog.getByRole('group', { name: 'Incoming mail (IMAP)' }).getByLabel('Server').fill('127.0.0.1');
  await dialog.getByRole('group', { name: 'Incoming mail (IMAP)' }).getByLabel('Port').fill('1');
  await dialog.getByLabel('Password', { exact: true }).fill('not-a-real-password');
  await dialog.getByRole('button', { name: 'Connect an account' }).click();
  await expect(
    dialog.getByText('The server cannot be reached. Check the server name and port.').first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('No email account connected yet.')).toBeVisible();
});

test('the Gmail wizard explains the setup and checks the client ID before opening a browser', async () => {
  await go('#/settings/email');
  await page.getByRole('button', { name: 'Connect Gmail' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Gmail through your own Google Cloud project' });
  await expect(dialog.getByText('enable the Gmail API')).toBeVisible();
  await expect(dialog.getByText(/gmail\.readonly, “restricted”/)).toBeVisible();
  await dialog.getByLabel('Client ID').fill('not-a-client-id');
  await dialog.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(dialog.getByText('A client ID ends with .apps.googleusercontent.com.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('stores an AI key encrypted without showing it again, and removes it', async () => {
  await go('#/settings/ai');
  await expect(page.getByRole('heading', { name: 'AI', exact: true })).toBeVisible();
  await expect(page.getByText('Not set', { exact: true })).toBeVisible();
  // A made-up key: nothing is called with it (no "Test key" here — that would reach the real API).
  await page.getByLabel('New API key').fill('sk-ant-e2e-not-a-real-key-000000');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Stored encrypted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('New API key')).toHaveValue('');
  await expect(page.getByTestId('ai-usage')).toContainText('0 calls');
  await page.getByRole('button', { name: 'Remove key' }).click();
  await page.getByRole('button', { name: 'Remove the key?' }).click();
  await expect(page.getByText('Not set', { exact: true })).toBeVisible();
});

test('settings are split into tabs, and each AI provider keeps its own key', async () => {
  await go('#/settings');
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('radio', { name: /Anthropic/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: /OpenRouter/ }).click();
  await expect(page.getByRole('radio', { name: /OpenRouter/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Model for reply labels')).toHaveValue('deepseek/deepseek-v4.1-flash');
  await expect(page.getByText(/openrouter\.ai\/keys/)).toBeVisible();
  await page.getByLabel('New API key').fill('sk-or-v1-e2e-not-a-real-key-000000');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Stored encrypted', { exact: true })).toBeVisible();
  await expect(page.getByTestId('ai-key-hint')).toHaveText('…0000');
  await expect(page.getByText(/Saved\. Check that the key works/)).toBeVisible();
  // An unsaved budget survives saving the key again; saving a key twice keeps it.
  await page.getByLabel('Monthly budget, USD').fill('25');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByLabel('New API key').fill('sk-or-v1-e2e-not-a-real-key-111111');
  await page.getByRole('button', { name: 'Replace key' }).click();
  await expect(page.getByTestId('ai-key-hint')).toHaveText('…1111');
  await expect(page.getByText('Stored encrypted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Monthly budget, USD')).toHaveValue('25');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByLabel('Monthly budget, USD')).toHaveValue('');
  // Anthropic has no key of its own; switching back shows that.
  await page.getByRole('radio', { name: /Anthropic/ }).click();
  await expect(page.getByText('Not set', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /OpenRouter/ }).click();
  await page.getByRole('button', { name: 'Remove key' }).click();
  await page.getByRole('button', { name: 'Remove the key?' }).click();
  await expect(page.getByText('Not set', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /Anthropic/ }).click();
});

test('a company page offers research, which needs an AI key', async () => {
  await go('#/companies');
  await page.getByRole('link', { name: 'Acme' }).first().click();
  await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Research company' }).click();
  await expect(page.getByText('Add an AI provider key in Settings → AI.')).toBeVisible();
});

test('the inbox opens with its filters and says when there are no replies', async () => {
  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'To review' })).toBeVisible();
  await expect(page.getByText('No replies yet.')).toBeVisible();
});

test('browser profiles: create, open in Chrome under your control, close, delete by name', async () => {
  await page.getByRole('link', { name: 'Browser profiles' }).click();
  await page.getByRole('button', { name: 'New profile' }).click();
  const create = page.getByRole('dialog', { name: 'New profile' });
  await create.getByLabel('Name').fill('E2E profile');
  await create.getByRole('button', { name: 'Create' }).click();
  const profile = page.getByTestId('profile').filter({ hasText: 'E2E profile' });
  await expect(profile).toContainText('Ready');
  await profile.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(profile).toContainText('You are in control', { timeout: 60_000 });
  await expect(profile.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await profile.getByRole('button', { name: 'Close' }).click();
  await expect(profile).toContainText('Ready', { timeout: 30_000 });
  // The Chrome window took the focus; in a background window animation frames slow down and
  // Playwright's "stable" check can stall (a CI flake). Bring the app back to the front.
  await focusApp();
  await profile.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “E2E profile”?' });
  await expect(confirm.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await confirm.getByLabel('Type “E2E profile” to confirm').fill('E2E profile');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('profile')).toHaveCount(0);
});

test('pause all shows a banner on every screen; emergency stop asks first; resume clears it', async () => {
  await go('#/status');
  const control = page.getByRole('region', { name: 'Control' });
  await control.getByRole('button', { name: 'Pause all' }).click();
  const banner = page.getByTestId('paused-banner');
  await expect(banner).toContainText('All outreach is paused');
  await page.getByRole('link', { name: 'Contacts' }).click();
  await expect(banner).toBeVisible();
  await go('#/status');
  await control.getByRole('button', { name: 'Emergency stop' }).click();
  await control.getByRole('button', { name: 'Stop everything now?' }).click();
  await expect(banner).toContainText('Emergency stop');
  await banner.getByRole('button', { name: 'Resume' }).click();
  await expect(banner).toHaveCount(0);
  await expect(control.getByRole('button', { name: 'Pause all' })).toBeVisible();
});

test('a campaign writes through a website contact form: prepared, approved as shown, sent once', async () => {
  test.setTimeout(240_000); // Chrome opens twice: to prepare the form and to send it
  // The sender: a browser profile and the details that go into forms.
  await go('#/browser');
  await page.getByRole('button', { name: 'New profile' }).click();
  const create = page.getByRole('dialog', { name: 'New profile' });
  await create.getByLabel('Name').fill('Forms E2E');
  await create.getByRole('button', { name: 'Create' }).click();
  await go('#/settings/forms');
  await page.getByLabel('Browser profile').selectOption({ label: 'Forms E2E' });
  await page.getByLabel('Your name').fill('Sam Sender');
  await page.getByLabel('Your email').fill('sam@sender.test');
  await page.getByLabel('Your company').fill('Sender Co');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Form sender saved' })).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);

  // A company whose website has a contact page (the local fixture site), and a contact there.
  // Chrome sends any *.localhost to this machine; a website needs a host name, not an IP.
  const site = fixtures.url.replace('127.0.0.1', 'fixtures.localhost');
  const ids = await page.evaluate(async (website) => {
    const bridge = (
      window as unknown as {
        tabreach: { invoke(t: string, p: unknown): Promise<{ ok: boolean; data?: { id: string } }> };
      }
    ).tabreach;
    const company = await bridge.invoke('companies.create', { name: 'Fixture Forms', website });
    const contact = await bridge.invoke('contacts.create', {
      firstName: 'Fiona',
      companyId: company.data?.id,
    });
    return { company: company.data?.id, contact: contact.data?.id };
  }, `${site}forms/index.html`);
  expect(ids.company).toBeTruthy();
  expect(ids.contact).toBeTruthy();

  await go('#/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New campaign' });
  await dialog.getByLabel('Name').fill('Form campaign');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Add message' }).click();
  const step = page.getByRole('region', { name: 'Message 1' });
  await step.getByLabel('Channel').selectOption('web_form');
  await expect(step.getByLabel('Who presses Send')).toHaveValue('auto');
  await step.getByLabel('Subject', { exact: true }).fill('Hello {{companyName}}');
  await step.getByLabel('Message', { exact: true }).fill('We build robots for {{companyName}}.');
  await page.getByLabel('Fallback time zone').fill('UTC');
  await page.getByLabel('Use the default sending hours from Settings').uncheck();
  await page.getByRole('button', { name: 'Sat' }).click();
  await page.getByRole('button', { name: 'Sun' }).click();
  await page.getByLabel('From', { exact: true }).fill('00:00');
  await page.getByLabel('Until', { exact: true }).fill('23:59');
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Campaign launched: version 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Add contacts' }).click();
  const add = page.getByRole('dialog', { name: 'Add contacts' });
  await add.getByRole('searchbox', { name: 'Search contacts' }).fill('Fiona');
  await add.getByRole('checkbox').first().check();
  await add.getByRole('button', { name: 'Add 1 contact' }).click();

  // The approval shows the form found behind the site's "Contact us" link, exactly as it will be sent.
  await go('#/approvals');
  const preview = page.getByTestId('form-preview');
  await expect(preview).toBeVisible({ timeout: 90_000 });
  await expect(preview).toContainText(`${site}forms/contact.html`);
  await expect(preview.getByRole('row', { name: /Your name/ })).toContainText('Sam Sender');
  await expect(preview.getByRole('row', { name: /Message/ })).toContainText(
    'We build robots for Fixture Forms.',
  );
  await expect(preview.getByRole('row', { name: /marketing emails/ })).toContainText(
    'Never ticked by TabReach',
  );
  await expect(preview.getByRole('img', { name: 'The form as the site shows it' })).toBeVisible();
  await focusApp(); // preparing the form opened Chrome, which took the focus
  await page.getByRole('button', { name: 'Approve' }).click();

  await go('#/campaigns');
  await page.getByRole('link', { name: /Form campaign/ }).click();
  await expect(page.getByTestId('enrollment')).toHaveAttribute('data-status', 'completed', {
    timeout: 90_000,
  });
});

test('LinkedIn stays off until the risk is accepted; a LinkedIn step starts assisted', async () => {
  await page.evaluate(async () => {
    const bridge = (window as unknown as { tabreach: { invoke(t: string, p: unknown): Promise<unknown> } })
      .tabreach;
    await bridge.invoke('profiles.create', { name: 'LinkedIn E2E', purpose: 'general' });
  });
  await go('#/settings/linkedin');
  await expect(page.getByText(/LinkedIn prohibits third-party software/)).toBeVisible();
  await page.getByLabel('Turn on the LinkedIn adapter').check();
  await page.getByLabel('Browser profile signed in to LinkedIn').selectOption({ label: 'LinkedIn E2E' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Read the notice and accept the risk first.')).toBeVisible();
  await page.getByLabel('I have read this and accept the risk for my account').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'LinkedIn settings saved' })).toBeVisible();
  // Saved means saved: no "Unsaved changes", and leaving the screen does not ask.
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);

  await go('#/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New campaign' });
  await dialog.getByLabel('Name').fill('LinkedIn campaign');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Add message' }).click();
  const step = page.getByRole('region', { name: 'Message 1' });
  await step.getByLabel('Channel').selectOption('linkedin');
  await expect(step.getByLabel('Who presses Send')).toHaveValue('assisted');
  await step.getByLabel('LinkedIn action').selectOption('connect');
  await expect(step.getByLabel('Invitation note')).toBeVisible();
  await expect(step.getByLabel('Subject', { exact: true })).toHaveCount(0);
  await step.getByLabel('Who presses Send').selectOption('auto');
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  await expect(step.getByText(/Auto is not allowed for this LinkedIn action/)).toBeVisible();
});

test('a saved settings screen is saved: no "Unsaved changes", leaving does not ask', async () => {
  await go('#/settings/policy');
  const cap = page.getByRole('spinbutton').first();
  await cap.fill('4');
  await cap.press('Enter');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.getByRole('link', { name: 'Contacts' }).click();
  await expect(page.getByText('You have unsaved changes on this screen.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
});

test('data retention: a shorter limit is saved and kept', async () => {
  await go('#/settings/data');
  await expect(page.getByTestId('retention-last-run')).toBeVisible();
  await page.getByLabel('Screenshots').selectOption('7');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Screenshots')).toHaveValue('7');
  await expect(page.getByLabel('Message texts')).toHaveValue('keep');
});

test('backup: restoring brings the data back, restarts core and starts paused', async () => {
  await go('#/settings/data');
  await page.getByLabel('Screenshots').selectOption('90');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  const backups = page.getByTestId('backups');
  await backups.getByRole('button', { name: 'Back up now' }).click();
  const manual = page.getByTestId('backup-row').filter({ hasText: 'Manual' });
  await expect(manual).toHaveCount(1);

  // Changed after the backup: the restore takes it back.
  await page.getByLabel('Screenshots').selectOption('7');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);

  await manual.getByRole('button', { name: 'Restore…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore and restart' }).click();
  await expect(backups.getByText(/Data restored from a backup/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Screenshots')).toHaveValue('90');
  // What was replaced is kept as its own backup.
  await expect(page.getByTestId('backup-row').filter({ hasText: 'Before restore' })).toHaveCount(1);
  const banner = page.getByTestId('paused-banner');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Resume' }).click();
  await expect(banner).toHaveCount(0);
});

test('switches the interface to Russian and keeps it after a reload', async () => {
  await go('#/settings');
  await page.getByLabel('Language').selectOption('ru');
  await expect(page.getByRole('link', { name: 'Контакты' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Контакты' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});
