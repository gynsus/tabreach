import { utilityProcess, type UtilityProcess } from 'electron';
import type { CoreState, Logger } from '@tabreach/protocol';
import { RESTART_EXIT_CODE, type ChildEnv } from '../shared/ipc';
import { RestartPolicy } from './restart-policy';

const STOP_TIMEOUT_MS = 3_000;

/** A utility process restarted by main with bounded backoff (ADR 012). */
export class Supervised {
  process: UtilityProcess | null = null;
  state: CoreState = 'starting';
  onSpawn: (proc: UtilityProcess) => void = () => {};
  onState: (state: CoreState) => void = () => {};
  /** After the process exited, whatever the reason (e.g. to clean up what it left running). */
  onExit: () => void = () => {};
  private readonly policy = new RestartPolicy();
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly name: 'core' | 'worker',
    private readonly entry: string,
    private readonly env: ChildEnv,
    private readonly logger: Logger,
    private readonly inheritStdio: boolean,
  ) {}

  start(): void {
    this.restartTimer = null;
    const proc = utilityProcess.fork(this.entry, [], {
      serviceName: `TabReach ${this.name}`,
      env: { ...process.env, ...this.env },
      stdio: this.inheritStdio ? 'inherit' : 'ignore',
    });
    proc.once('spawn', () => {
      this.process = proc;
      this.logger.info({ event: 'process.spawned', name: this.name, pid: proc.pid }, 'process spawned');
      this.setState('running');
      this.onSpawn(proc);
    });
    proc.once('exit', (code) => {
      if (this.process === proc) this.process = null;
      this.onExit();
      if (this.stopping) return;
      if (code === RESTART_EXIT_CODE) {
        // Asked for (a restore): start again at once, not counted as a crash.
        this.logger.info({ event: 'process.restart_requested', name: this.name }, 'process restarting');
        this.setState('restarting');
        this.start();
        return;
      }
      const decision = this.policy.onCrash();
      this.logger.error({ event: 'process.exited', name: this.name, code, ...decision }, 'process exited');
      if (decision.restart) {
        this.setState('restarting');
        this.restartTimer = setTimeout(() => this.start(), decision.delayMs);
      } else {
        // Too many crashes: stop trying and let the UI say so instead of retrying forever.
        this.setState('failed');
      }
    });
  }

  /** Asks the process to exit (SIGTERM lets core close the database) and waits, bounded. */
  stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.process;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn({ event: 'process.stop_timeout', name: this.name }, 'process did not exit in time');
        proc.kill();
        resolve();
      }, STOP_TIMEOUT_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill();
    });
  }

  private setState(state: CoreState): void {
    this.state = state;
    this.onState(state);
  }
}
