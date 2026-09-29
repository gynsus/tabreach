import type { DatabaseSync } from 'node:sqlite';
import { bundledPack } from '@tabreach/adapter-packs';
import {
  linkedinSettingsSchema,
  RpcError,
  uuidv7,
  type LinkedinSettings,
  type Logger,
  type RpcPeer,
  type TaskResult,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { BrowserActionChannel, type BrowserDispatch } from '../browser/browser-channel.js';
import type { BrowserService } from '../browser/browser-service.js';
import type { BrowserCheckpoints } from '../browser/checkpoints.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SettingsRepository } from '../settings/settings.js';

const KEY = 'linkedin';
const PACK = 'linkedin';
const DAY_MS = 24 * 60 * 60_000;
const TOUCH = "('executing', 'completed', 'unknown')";

/** The product's defaults come from the pack (docs/14); settings may only lower them unless raised. */
function packLimits() {
  const limits = bundledPack(PACK)?.limits;
  return {
    connectPerDay: limits?.perDay.connect ?? 15,
    connectPerWeek: limits?.perWeek.connect ?? 80,
    messagePerDay: limits?.perDay.message ?? 30,
    minSpacingMs: (limits?.minSpacingSeconds ?? 90) * 1000,
  };
}

const DEFAULTS: LinkedinSettings = {
  enabled: false,
  profileId: null,
  riskAcknowledgedAt: null,
  autoConnect: false,
  autoMessage: false,
  limits: {
    connectPerDay: packLimits().connectPerDay,
    connectPerWeek: packLimits().connectPerWeek,
    messagePerDay: packLimits().messagePerDay,
  },
  limitsRaised: false,
};

type Worker = Pick<RpcPeer, 'request'>;

/**
 * The LinkedIn adapter in core (docs/14, Phase 7): its switch, the account's browser profile, the
 * per-action opt-in to `auto`, the throttles, and the channel. Off by default and whenever its
 * setting cannot be read (fails closed, FR-LIN-001). Every message first reads the conversation
 * in the same task run: if the person answered, nothing is sent (FR-LIN-004).
 */
export class LinkedinService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      audit: AuditLog;
      settings: SettingsRepository;
      browser: BrowserService;
      checkpoints: BrowserCheckpoints;
      worker: () => Worker | null;
      logger: Logger;
    },
  ) {}

  settings(): LinkedinSettings {
    return this.d.settings.get(KEY, linkedinSettingsSchema) ?? DEFAULTS;
  }

  update(
    input: Omit<LinkedinSettings, 'riskAcknowledgedAt'> & { acknowledgeRisk: boolean },
    ctx: CommandContext,
  ): LinkedinSettings {
    const current = this.settings();
    const acknowledged = input.acknowledgeRisk
      ? (current.riskAcknowledgedAt ?? this.d.now().toISOString())
      : null;
    const fields: Record<string, string> = {};
    if (input.enabled && !acknowledged) fields.acknowledgeRisk = 'linkedin.riskRequired';
    if (input.enabled && !input.profileId) fields.profileId = 'linkedin.profileRequired';
    if (input.profileId) {
      const profile = this.d.browser.get(input.profileId);
      if (profile.purpose === 'research' || profile.status === 'archived')
        fields.profileId = 'linkedin.profileUnsuitable';
    }
    const defaults = packLimits();
    const above =
      input.limits.connectPerDay > defaults.connectPerDay ||
      input.limits.connectPerWeek > defaults.connectPerWeek ||
      input.limits.messagePerDay > defaults.messagePerDay;
    // Raising a throttle above the product's default is an explicit, acknowledged choice (FR-LIN-005).
    if (above && !input.limitsRaised) fields.limits = 'linkedin.limitsRaiseRequired';
    if (Object.keys(fields).length > 0) throw RpcError.validation(fields, 'linkedin.settingsInvalid');
    const next: LinkedinSettings = {
      enabled: input.enabled,
      profileId: input.profileId,
      riskAcknowledgedAt: acknowledged,
      autoConnect: input.autoConnect,
      autoMessage: input.autoMessage,
      limits: input.limits,
      limitsRaised: above && input.limitsRaised,
    };
    this.d.settings.set(KEY, next);
    this.d.audit.record({
      actorType: 'user',
      actionType: 'linkedin.settings_updated',
      objectType: 'settings',
      payload: {
        enabled: next.enabled,
        autoConnect: next.autoConnect,
        autoMessage: next.autoMessage,
        limitsRaised: next.limitsRaised,
      },
      correlationId: ctx.correlationId,
    });
    return next;
  }

  /** null when the adapter may act; otherwise why not. Fails closed. */
  unavailable(): string | null {
    let s: LinkedinSettings;
    try {
      s = this.settings();
    } catch {
      return 'linkedin.disabled';
    }
    if (!s.enabled || !s.riskAcknowledgedAt) return 'linkedin.disabled';
    if (!s.profileId) return 'linkedin.noProfile';
    return null;
  }

  /** `auto` only where the person opted in for that action class (FR-LIN-002); otherwise assisted. */
  modeFor(action: 'connect' | 'message', stepMode: 'auto' | 'assisted'): 'auto' | 'assisted' {
    const s = this.settings();
    const allowed = action === 'connect' ? s.autoConnect : s.autoMessage;
    return stepMode === 'auto' && allowed ? 'auto' : 'assisted';
  }

  /** Invitations per day and week, messages per day, for the account (the pack's throttles). */
  checkLimits(actionType: string, idempotencyKey: string): { until: Date; rule: string } | null {
    const s = this.settings();
    const windows: [string, number, number][] =
      actionType === 'linkedin.connect'
        ? [
            ['linkedin.connect.day', s.limits.connectPerDay, DAY_MS],
            ['linkedin.connect.week', s.limits.connectPerWeek, 7 * DAY_MS],
          ]
        : actionType === 'linkedin.message'
          ? [['linkedin.message.day', s.limits.messagePerDay, DAY_MS]]
          : [];
    const now = this.d.now().getTime();
    for (const [rule, limit, span] of windows) {
      const rows = this.d.db
        .prepare(
          `SELECT updated_at FROM side_effects
           WHERE channel = 'linkedin' AND channel_account_id IS ? AND action_type = ? AND status IN ${TOUCH}
             AND idempotency_key != ? AND updated_at > ? ORDER BY updated_at`,
        )
        .all(s.profileId, actionType, idempotencyKey, new Date(now - span).toISOString()) as {
        updated_at: string;
      }[];
      if (rows.length >= limit) {
        const oldest = rows[rows.length - Math.max(limit, 1)] ?? rows[0];
        return { until: new Date(new Date(oldest?.updated_at ?? now).getTime() + span), rule };
      }
    }
    return null;
  }

  /** The linkedin channel: a message reads the thread first; both actions check the person's identity. */
  channel(): BrowserActionChannel | undefined {
    const profileId = this.settings().profileId;
    if (!profileId) return undefined;
    const pack = bundledPack(PACK);
    const actionOf = (key: string) =>
      (
        this.d.db
          .prepare('SELECT action_type, workflow_run_id FROM side_effects WHERE idempotency_key = ?')
          .get(key) as { action_type: string; workflow_run_id: string } | undefined
      )?.action_type;
    const stepModeOf = (runId: string): 'auto' | 'assisted' => {
      const row = this.d.db
        .prepare(
          `SELECT s.execution_mode FROM workflow_runs r JOIN campaign_enrollments e ON e.id = r.business_id
           JOIN sequence_steps s ON s.campaign_version_id = e.campaign_version_id AND s.position = r.step_position
           WHERE r.id = ?`,
        )
        .get(runId) as { execution_mode: string } | undefined;
      return row?.execution_mode === 'auto' ? 'auto' : 'assisted';
    };
    const dispatch: BrowserDispatch = {
      packId: PACK,
      packVersion: pack?.version ?? 'none',
      assisted: (message, runId) => {
        const action = actionOf(message.idempotencyKey) === 'linkedin.connect' ? 'connect' : 'message';
        return this.modeFor(action, stepModeOf(runId)) === 'assisted';
      },
      run: async (worker, task, options) => {
        const actionType = actionOf(task.message.idempotencyKey);
        const action = actionType === 'linkedin.connect' ? 'connect' : 'message';
        const identity = { profileUrl: task.message.target, name: task.message.recipientName ?? '' };
        if (!identity.name) return refused('task.identityRequired');
        if (action === 'message') {
          // FR-LIN-004: the conversation is read right before writing; an answer stops the step.
          const thread = await worker.request(
            'thread.read',
            {
              taskId: uuidv7(),
              sessionId: task.sessionId,
              packId: PACK,
              url: task.message.target,
              readerId: 'linkedin.thread',
              identity,
            },
            options,
          );
          if (thread.status === 'needs_human') return { ...refused('needs_human'), status: 'needs_human' };
          if (thread.status === 'unsupported_state' && thread.stateId && !thread.errorKey) {
            // A known page that is not a conversation (not connected yet): the engine decides.
            return { ...refused(null), status: 'unsupported_state', stateId: thread.stateId };
          }
          // Could not read it: nothing is written without knowing (fails closed).
          if (thread.status !== 'ok') return refused(thread.errorKey ?? 'linkedin.threadUnread');
          if (thread.replied) return refused('linkedin.replied');
        }
        const note = task.message.body.trim();
        return worker.request(
          'task.run',
          {
            taskId: task.taskId,
            sessionId: task.sessionId,
            taskType: 'commit',
            packId: PACK,
            url: task.message.target,
            actionId:
              action === 'message' ? 'linkedin.message' : note ? 'linkedin.connect.note' : 'linkedin.connect',
            params: action === 'message' ? { body: task.message.body } : { note },
            mode: this.modeFor(action, stepModeOf(task.workflowRunId)),
            identity,
          },
          options,
        );
      },
    };
    const channel = new BrowserActionChannel('linkedin', profileId, dispatch, this.d, {
      minSpacingMs: packLimits().minSpacingMs,
      dailyLimit: null,
    });
    return Object.assign(channel, {
      unavailable: () => this.unavailable(),
      checkLimits: (actionType: string, key: string) => this.checkLimits(actionType, key),
    });
  }
}

/** Nothing was pressed: the reason is carried back as a not-sent result. */
function refused(errorKey: string | null): TaskResult {
  return {
    status: 'failed',
    stateId: null,
    stateKind: null,
    packVersion: bundledPack(PACK)?.version ?? 'none',
    url: null,
    diagnostics: null,
    errorKey,
    committed: false,
  };
}
