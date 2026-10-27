// Notarization that survives a slow Apple queue and a dropped connection (docs/DEVELOPMENT.md
// "Signing and notarization"). `notarytool submit --wait` gives up on the first network error while
// Apple may hold a submission for an hour or more; this submits, then polls with retries until a
// deadline, and staples the ticket.
//
// electron-builder calls the exported function after signing the app (afterSign), before the DMG
// is made. From the command line it notarizes and staples the files it is given:
//   node scripts/notarize.cjs release/*.dmg
//
// Credentials come only from the environment. Commands are never echoed: their arguments may hold
// an app-specific password.
const { execFile } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');

const minutes = Number(process.env.TABREACH_NOTARY_MINUTES) || 80;
const POLL_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`  • notarize  ${msg}`);

/** Runs a command; resolves with its exit code and output, never with the command line. */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** notarytool's JSON answer, or {} when it printed something else. */
function parse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}

const firstLine = (r) => (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) ?? '';

function auth() {
  const e = process.env;
  if (e.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', e.APPLE_KEYCHAIN_PROFILE];
  if (e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER)
    return ['--key', e.APPLE_API_KEY, '--key-id', e.APPLE_API_KEY_ID, '--issuer', e.APPLE_API_ISSUER];
  if (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID)
    return [
      '--apple-id',
      e.APPLE_ID,
      '--password',
      e.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id',
      e.APPLE_TEAM_ID,
    ];
  throw new Error('No notarization credentials in the environment');
}

const notarytool = (args) => run('xcrun', ['notarytool', ...args, ...auth(), '--output-format', 'json']);

async function submit(file) {
  // A retried upload may leave a second submission of the same file at Apple; that is harmless.
  for (let attempt = 1; ; attempt++) {
    const r = await notarytool(['submit', file]);
    const id = r.code === 0 ? parse(r.stdout).id : undefined;
    if (id) return id;
    if (attempt === 3) throw new Error(`notarytool submit failed: ${firstLine(r)}`);
    log(`upload failed (${firstLine(r)}), retrying`);
    await sleep(30_000 * attempt);
  }
}

async function waitFor(id) {
  const deadline = Date.now() + minutes * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const r = await notarytool(['info', id]);
    const status = r.code === 0 ? parse(r.stdout).status : undefined;
    if (!status) {
      // A dropped connection or a timeout says nothing about the submission: ask again.
      log(`status unavailable (${firstLine(r)}), retrying`);
      continue;
    }
    if (status !== last) log(`${id}: ${status}`);
    last = status;
    if (status === 'Accepted') return;
    if (status !== 'In Progress') {
      const report = await notarytool(['log', id]);
      console.log(report.stdout);
      throw new Error(`Apple did not accept submission ${id}: ${status}`);
    }
  }
  throw new Error(`Submission ${id} still ${last || 'unknown'} after ${minutes} minutes`);
}

async function staple(file) {
  // Apple's ticket can take a moment to reach the CDN stapler reads from.
  for (let attempt = 1; ; attempt++) {
    const r = await run('xcrun', ['stapler', 'staple', file]);
    if (r.code === 0) return;
    if (attempt === 5) throw new Error(`stapler failed for ${basename(file)}: ${firstLine(r)}`);
    await sleep(30_000);
  }
}

/** Notarizes and staples a .dmg, .pkg or .app (sent to Apple as a zip). */
async function notarize(file) {
  let upload = file;
  let dir;
  if (file.endsWith('.app')) {
    dir = mkdtempSync(join(tmpdir(), 'tabreach-notarize-'));
    upload = join(dir, `${basename(file, '.app')}.zip`);
    const r = await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', file, upload]);
    if (r.code !== 0) throw new Error(`ditto failed: ${firstLine(r)}`);
  }
  try {
    log(`submitting ${basename(file)}`);
    const id = await submit(upload);
    log(`${id}: submitted, waiting up to ${minutes} minutes`);
    await waitFor(id);
    await staple(file);
    log(`${basename(file)}: accepted and stapled`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** electron-builder afterSign hook. */
async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  await notarize(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}

module.exports = afterSign;
module.exports.notarize = notarize;

if (require.main === module) {
  (async () => {
    const files = process.argv.slice(2);
    if (!files.length) throw new Error('usage: node scripts/notarize.cjs <file.dmg|file.app>...');
    // One file after another keeps the log readable; each waits on Apple independently anyway.
    for (const file of files) await notarize(file);
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
