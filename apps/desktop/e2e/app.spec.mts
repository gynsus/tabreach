import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    env: { ...process.env, TABREACH_USER_DATA_DIR: userData },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  await fixtures?.close();
  rmSync(userData, { recursive: true, force: true });
});

const go = (path: string) => page.evaluate((p) => (window.location.hash = p), path);
/** Data rows of a table (the header row has no cells). */
const dataRows = (table: string) =>
  page
    .getByRole('table', { name: table })
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });

test('status screen shows core, database, secret storage and worker working', async () => {
  await go('#/status');
  await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
  for (const id of ['core', 'database', 'secrets', 'worker', 'chrome']) {
    await expect(page.getByTestId(`component-${id}`)).toHaveAttribute('data-status', 'ok', {
      timeout: 20_000,
    });
  }
  await expect(page.getByTestId('component-database')).toContainText('schema version 5');
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
  await dialog.getByRole('button', { name: /Import 4 rows/ }).click();
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

test('switches the interface to Russian and keeps it after a reload', async () => {
  await go('#/settings');
  await page.getByLabel('Language').selectOption('ru');
  await expect(page.getByRole('link', { name: 'Контакты' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Контакты' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});
