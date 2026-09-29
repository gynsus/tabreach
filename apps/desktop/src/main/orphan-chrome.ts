import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '@tabreach/protocol';

const execFileAsync = promisify(execFile);

/**
 * Chrome processes started for TabReach profiles: their command line names a user data directory
 * inside our profiles folder. Chrome the user runs themselves never does (docs/07 "Profile ownership").
 */
export function orphanChromePids(psOutput: string, profilesRoot: string): number[] {
  const root = profilesRoot.replace(/\/+$/, '');
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[2] ?? '';
    if (command.includes(`--user-data-dir=${root}/`)) pids.push(Number(m[1]));
  }
  return pids;
}

/**
 * Ends Chrome processes left behind by a worker that crashed or was killed: they would keep the
 * profile locked. Runs when the worker exits and when the app starts or quits.
 */
export async function killOrphanChrome(profilesRoot: string, logger: Logger): Promise<number> {
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync('/bin/ps', ['-Ao', 'pid=,command='], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    logger.warn({ event: 'chrome.orphan_scan_failed', err: error }, 'could not list processes');
    return 0;
  }
  const pids = orphanChromePids(output, profilesRoot).filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between listing and killing: nothing left to clean.
    }
  }
  if (pids.length > 0)
    logger.info({ event: 'chrome.orphans_killed', count: pids.length }, 'closed leftover Chrome');
  return pids.length;
}
