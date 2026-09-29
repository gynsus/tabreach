import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  silentLogger,
  uiSettingsSchema,
  type ChangedEntity,
  type Logger,
  type RpcPeer,
  type UiSettings,
  type UncertainSend,
} from '@tabreach/protocol';
import { AiGateway } from './ai/gateway.js';
import { ReplyClassifier } from './ai/reply-classifier.js';
import { TimelineService } from './audit/timeline.js';
import { BrowserService } from './browser/browser-service.js';
import { DraftWriter } from './drafts/draft-writer.js';
import { ResearchService } from './research/research-service.js';
import { AuditLog } from './audit/audit-log.js';
import { ApprovalService } from './campaigns/approval-service.js';
import { CampaignService } from './campaigns/campaign-service.js';
import { CampaignEngine } from './campaigns/engine.js';
import { ContactPolicy } from './campaigns/policy.js';
import type { ChannelResolver, MessageChannel } from './channels/channel.js';
import { TestChannel } from './channels/test-channel.js';
import { CommandLog } from './commands/command-log.js';
import { AccountService, type GmailDeps } from './email/accounts.js';
import type { Http } from './email/gmail.js';
import { InboxService } from './email/inbox.js';
import { imapSmtpClients } from './email/imap-smtp.js';
import type { MailClients } from './email/transport.js';
import { JobQueue } from './jobs/queue.js';
import { SideEffectLedger } from './ledger/side-effects.js';
import { ExportService } from './prospects/export-service.js';
import { ImportService } from './prospects/import-service.js';
import { ProspectService } from './prospects/prospect-service.js';
import { SecretStore, type SecretCipher } from './secrets/secrets.js';
import { SettingsRepository } from './settings/settings.js';
import { SuppressionService } from './suppressions/suppression-service.js';

const UI_SETTINGS_KEY = 'ui';
const DEFAULT_UI: UiSettings = { language: 'en' };

export interface AppServicesOptions {
  now?: () => Date;
  logger?: Logger;
  /** Called after a change so core can tell every window to refetch (event `data.changed`). */
  onChanged?: (entities: ChangedEntity[]) => void;
  /** Called after a job is enqueued so the dispatcher wakes up instead of polling. */
  onJobEnqueued?: () => void;
  /** Channels available by name; defaults to the local test channel. Email channels come from accounts. */
  channels?: MessageChannel[];
  /** Encrypts secrets through main's safeStorage; without it, storing a secret fails. */
  cipher?: SecretCipher;
  /** SMTP/IMAP clients; tests replace the real ones. */
  mailClients?: MailClients;
  /** HTTPS for Google APIs and main's OAuth loopback; tests replace them. */
  gmail?: GmailDeps;
  /** HTTPS for AI providers; tests replace it. */
  aiHttp?: Http;
  /** HTTP for research page fetching; tests replace it. */
  webHttp?: Http;
  /** Waiting between requests to the same site (research pacing); tests skip it. */
  sleep?: (ms: number) => Promise<void>;
  /** DNS for research fetching (tests map fixture hosts to a public address). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** The browser worker's channel, when one is attached (it restarts independently). */
  worker?: () => Pick<RpcPeer, 'request'> | null;
  /** `chromium` for profiles in tests; the user's Google Chrome otherwise. */
  browserChannel?: 'chrome' | 'chromium';
}

const noCipher: SecretCipher = {
  encrypt: () => Promise.reject(new RpcError('UNAVAILABLE', 'Secret storage is not available')),
  decrypt: () => Promise.reject(new RpcError('UNAVAILABLE', 'Secret storage is not available')),
};

const jobNotFound = () => new RpcError('NOT_FOUND', 'Job not found', 'job.notFound');

/** Domain services behind the app protocol. One instance per core process. */
export class AppServices {
  readonly audit: AuditLog;
  readonly commands: CommandLog;
  readonly prospects: ProspectService;
  readonly imports: ImportService;
  readonly exports: ExportService;
  readonly suppressions: SuppressionService;
  readonly settings: SettingsRepository;
  readonly jobs: JobQueue;
  readonly ledger: SideEffectLedger;
  readonly policy: ContactPolicy;
  readonly engine: CampaignEngine;
  readonly campaigns: CampaignService;
  readonly approvals: ApprovalService;
  readonly secrets: SecretStore;
  readonly accounts: AccountService;
  readonly inbox: InboxService;
  readonly ai: AiGateway;
  readonly classifier: ReplyClassifier;
  readonly research: ResearchService;
  readonly drafts: DraftWriter;
  readonly timeline: TimelineService;
  readonly browser: BrowserService;
  private readonly changed: (entities: ChangedEntity[]) => void;
  private readonly now: () => Date;

  constructor(
    private readonly db: DatabaseSync,
    options: AppServicesOptions = {},
  ) {
    const now = options.now ?? (() => new Date());
    this.now = now;
    const logger = options.logger ?? silentLogger;
    this.changed = options.onChanged ?? (() => {});
    this.audit = new AuditLog(db, now);
    this.timeline = new TimelineService(db);
    this.browser = new BrowserService({
      db,
      now,
      audit: this.audit,
      worker: options.worker ?? (() => null),
      changed: (entities) => this.changed(entities),
      logger: logger.child({ component: 'browser' }),
      ...(options.browserChannel ? { browserChannel: options.browserChannel } : {}),
    });
    this.commands = new CommandLog(db, now);
    this.jobs = new JobQueue(db, now, options.onJobEnqueued);
    this.ledger = new SideEffectLedger(db, now);
    this.prospects = new ProspectService(db, this.audit, now);
    this.imports = new ImportService(db, this.prospects, this.audit);
    this.exports = new ExportService(db, this.audit, now);
    this.suppressions = new SuppressionService(db, this.audit, now);
    this.settings = new SettingsRepository(db, now, (key) =>
      logger.warn({ event: 'settings.invalid', key }, 'stored setting failed validation; using defaults'),
    );
    this.secrets = new SecretStore(db, options.cipher ?? noCipher, now);
    this.accounts = new AccountService(
      db,
      this.audit,
      this.secrets,
      options.mailClients ?? imapSmtpClients,
      now,
      logger.child({ component: 'email' }),
      (accountId) => this.inbox.schedulePoll(accountId),
      options.gmail,
    );
    const named = new Map(
      (options.channels ?? [new TestChannel(db, now, 60_000)]).map((c) => [c.channel, c] as const),
    );
    const channels: ChannelResolver = (channel, config) =>
      named.get(channel) ?? (channel === 'email' ? this.accounts.channel(config.emailAccountId) : undefined);
    this.policy = new ContactPolicy(db, this.settings, now);
    this.engine = new CampaignEngine({
      db,
      now,
      audit: this.audit,
      jobs: this.jobs,
      ledger: this.ledger,
      policy: this.policy,
      channels,
      logger: logger.child({ component: 'campaigns' }),
      changed: (entities) => this.changed(entities),
      onSent: (sent) => this.inbox.recordSent(sent),
      drafter: { write: (req, signal, correlationId) => this.drafts.write(req, signal, correlationId) },
      beforeSend: async (channel, signal, correlationId) => {
        if (channel.channel === 'email' && channel.accountId) {
          await this.inbox.ensureFresh(channel.accountId, signal, correlationId);
        }
      },
    });
    this.ai = new AiGateway(
      db,
      this.settings,
      this.secrets,
      this.audit,
      options.aiHttp ?? ((url, init) => fetch(url, init)),
      now,
      logger.child({ component: 'ai' }),
    );
    this.classifier = new ReplyClassifier({
      db,
      gateway: this.ai,
      jobs: this.jobs,
      suppressions: this.suppressions,
      audit: this.audit,
      logger: logger.child({ component: 'ai' }),
      changed: (entities) => this.changed(entities),
    });
    this.research = new ResearchService({
      db,
      now,
      audit: this.audit,
      ai: this.ai,
      jobs: this.jobs,
      http: options.webHttp ?? ((url, init) => fetch(url, init)),
      logger: logger.child({ component: 'research' }),
      changed: (entities) => this.changed(entities),
      language: () => (this.settings.get(UI_SETTINGS_KEY, uiSettingsSchema) ?? DEFAULT_UI).language,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
    });
    this.drafts = new DraftWriter({
      ai: this.ai,
      research: this.research,
      now,
      logger: logger.child({ component: 'drafts' }),
    });
    this.inbox = new InboxService({
      db,
      now,
      audit: this.audit,
      engine: this.engine,
      policy: this.policy,
      suppressions: this.suppressions,
      accounts: this.accounts,
      jobs: this.jobs,
      logger: logger.child({ component: 'inbox' }),
      changed: (entities) => this.changed(entities),
      onReply: (messageId) => this.classifier.enqueue(messageId),
    });
    this.campaigns = new CampaignService(
      db,
      this.audit,
      this.engine,
      this.jobs,
      channels,
      now,
      (contactId, companyId) => this.policy.replyHold(contactId, companyId),
      () => this.ai.settings().keySet,
    );
    this.approvals = new ApprovalService(db, this.audit, this.engine, this.ledger, now);
  }

  /** Registers every app-channel handler except those owned by CoreService itself (health, browser). */
  register(peer: RpcPeer): RpcPeer {
    const ctx = (c: { correlationId: string }) => ({ correlationId: c.correlationId });
    /** Runs a mutation, then announces which data changed. */
    const mutate = <T>(entities: ChangedEntity[], fn: () => T): T => {
      const result = fn();
      this.changed([...entities, 'activity']);
      return result;
    };
    return peer
      .handle('settings.ui.get', () => this.settings.get(UI_SETTINGS_KEY, uiSettingsSchema) ?? DEFAULT_UI)
      .handle('settings.ui.update', (s) =>
        mutate(['settings'], () => {
          this.settings.set(UI_SETTINGS_KEY, s);
          return s;
        }),
      )
      .handle('companies.list', (p) => this.prospects.listCompanies(p))
      .handle('companies.get', ({ id }) => this.prospects.getCompany(id))
      .handle('companies.create', (p, c) =>
        mutate(['company'], () =>
          this.commands.once(c.idempotencyKey, 'companies.create', () =>
            this.prospects.createCompany(p, ctx(c)),
          ),
        ),
      )
      .handle('companies.update', (p, c) =>
        mutate(['company'], () => this.prospects.updateCompany(p, ctx(c))),
      )
      .handle('contacts.list', (p) => this.prospects.listContacts(p))
      .handle('contacts.get', ({ id }) => this.prospects.getContact(id))
      .handle('contacts.create', (p, c) =>
        mutate(['contact', 'company'], () =>
          this.commands.once(c.idempotencyKey, 'contacts.create', () =>
            this.prospects.createContact(p, ctx(c)),
          ),
        ),
      )
      .handle('contacts.update', (p, c) =>
        mutate(['contact', 'company'], () => this.prospects.updateContact(p, ctx(c))),
      )
      .handle('imports.prospects.preview', ({ csv }) => this.imports.preview(csv))
      .handle('imports.prospects.commit', (p, c) =>
        mutate(['company', 'contact'], () =>
          this.commands.once(c.idempotencyKey, 'imports.prospects.commit', () =>
            this.imports.commit(p.csv, p.mapping, p.onMatch, ctx(c)),
          ),
        ),
      )
      .handle('exports.prospects', (_p, c) => mutate([], () => this.exports.exportProspects(ctx(c))))
      .handle('suppressions.list', (p) => this.suppressions.list(p))
      .handle('suppressions.add', (p, c) =>
        mutate(['suppression'], () => this.suppressions.add(p.kind, p.value, ctx(c))),
      )
      .handle('suppressions.remove', ({ id }, c) =>
        mutate(['suppression'], () => ({ removed: this.suppressions.remove(id, ctx(c)) })),
      )
      .handle('suppressions.import', ({ csv }, c) =>
        mutate(['suppression'], () =>
          this.commands.once(c.idempotencyKey, 'suppressions.import', () =>
            this.suppressions.importCsv(csv, ctx(c)),
          ),
        ),
      )
      .handle('campaigns.list', ({ includeArchived }) => ({ items: this.campaigns.list(includeArchived) }))
      .handle('campaigns.get', ({ id }) => this.campaigns.get(id))
      .handle('campaigns.create', (p, c) =>
        mutate(['campaign'], () =>
          this.commands.once(c.idempotencyKey, 'campaigns.create', () => this.campaigns.create(p, ctx(c))),
        ),
      )
      .handle('campaigns.update', (p, c) => mutate(['campaign'], () => this.campaigns.update(p, ctx(c))))
      .handle('campaigns.launch', ({ id }, c) =>
        mutate(['campaign', 'enrollment'], () => this.campaigns.launch(id, ctx(c))),
      )
      .handle('campaigns.pause', ({ id }, c) =>
        mutate(['campaign', 'enrollment'], () => this.campaigns.pause(id, ctx(c))),
      )
      .handle('campaigns.resume', ({ id }, c) =>
        mutate(['campaign', 'enrollment'], () => this.campaigns.resume(id, ctx(c))),
      )
      .handle('campaigns.archive', ({ id }, c) =>
        mutate(['campaign', 'enrollment', 'approval'], () => this.campaigns.archive(id, ctx(c))),
      )
      .handle('campaigns.enroll', (p, c) =>
        mutate(['campaign', 'enrollment'], () =>
          this.commands.once(c.idempotencyKey, 'campaigns.enroll', () =>
            this.campaigns.enroll(p.campaignId, p.contactIds, ctx(c)),
          ),
        ),
      )
      .handle('enrollments.list', (p) => this.campaigns.listEnrollments(p.campaignId, p))
      .handle('enrollments.pause', ({ id }, c) =>
        mutate(['enrollment', 'campaign'], () => this.campaigns.pauseEnrollment(id, ctx(c))),
      )
      .handle('enrollments.resume', ({ id }, c) =>
        mutate(['enrollment', 'campaign'], () => this.campaigns.resumeEnrollment(id, ctx(c))),
      )
      .handle('enrollments.stop', ({ id }, c) =>
        mutate(['enrollment', 'campaign', 'approval'], () => this.campaigns.stopEnrollment(id, ctx(c))),
      )
      .handle('approvals.pending', ({ campaignId }) => ({ items: this.approvals.pending(campaignId) }))
      .handle('approvals.approve', (p, c) =>
        mutate(['approval', 'enrollment', 'campaign'], () => {
          this.approvals.approve(p.approvalId, p.contentHash, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('approvals.reject', (p, c) =>
        mutate(['approval', 'enrollment', 'campaign'], () => {
          this.approvals.reject(p.approvalId, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('approvals.skip', (p, c) =>
        mutate(['approval', 'enrollment', 'campaign'], () => {
          this.approvals.skip(p.approvalId, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('drafts.history', (p) => ({ items: this.approvals.history(p.draftId) }))
      .handle('drafts.revise', (p, c) =>
        mutate(['approval'], () => this.approvals.revise(p.draftId, p.subject, p.body, ctx(c))),
      )
      .handle('policy.settings.get', () => this.policy.current())
      .handle('policy.settings.update', (p, c) =>
        mutate(['settings'], () => {
          this.policy.update(p);
          this.audit.record({
            actorType: 'user',
            actionType: 'policy.updated',
            objectType: 'settings',
            correlationId: c.correlationId,
          });
          return p;
        }),
      )
      .handle('jobs.needsAttention', () => ({
        items: this.jobs.needsAttention().map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          lastErrorClass: j.last_error_class,
          lastError: j.last_error_redacted,
          updatedAt: j.updated_at,
        })),
      }))
      .handle('conversations.list', (p) => this.inbox.list(p.filter, p))
      .handle('conversations.get', ({ id }) => this.inbox.get(id))
      .handle('conversations.markRead', ({ id }) =>
        mutate(['conversation'], () => {
          this.inbox.markRead(id);
          return { ok: true as const };
        }),
      )
      .handle('conversations.review', (p, c) =>
        mutate(['conversation', 'enrollment', 'campaign'], () => {
          this.inbox.review(p.messageId, p.decision, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('research.start', (p, c) => mutate(['research'], () => this.research.start(p, ctx(c))))
      .handle('research.list', ({ companyId }) => ({ items: this.research.list(companyId) }))
      .handle('research.get', ({ id }) => this.research.get(id))
      .handle('ai.settings.get', () => this.ai.settings())
      .handle('ai.settings.update', (p, c) => mutate(['settings'], () => this.ai.update(p, ctx(c))))
      .handle('ai.setKey', async ({ provider, apiKey }, c) => {
        await this.ai.setKey(provider, apiKey, ctx(c));
        this.changed(['settings', 'activity']);
        return { ok: true as const };
      })
      .handle('ai.removeKey', ({ provider }, c) =>
        mutate(['settings'], () => {
          this.ai.removeKey(provider, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('ai.testKey', (_p, c) => this.ai.testKey(c.correlationId))
      .handle('ai.usage', ({ month }) => this.ai.usage(month))
      .handle('accounts.list', () => ({ items: this.accounts.list() }))
      .handle('accounts.connectImap', async (p, c) => {
        const account = await this.accounts.connectImap(p, ctx(c));
        this.changed(['account', 'activity']);
        return account;
      })
      .handle('accounts.connectGmail', async (p, c) => {
        const account = await this.accounts.connectGmail(p, ctx(c));
        this.changed(['account', 'activity']);
        return account;
      })
      .handle('accounts.update', async (p, c) => {
        const account = await this.accounts.update(p, ctx(c));
        this.changed(['account', 'activity']);
        return account;
      })
      .handle('accounts.test', ({ id }) => this.accounts.test(id))
      .handle('accounts.disconnect', async ({ id }, c) => {
        await this.accounts.disconnect(id, ctx(c));
        this.changed(['account', 'activity']);
        return { ok: true as const };
      })
      .handle('contacts.replyHold', ({ id }) => {
        const contact = this.prospects.getContact(id);
        return { hold: this.policy.replyHold(id, contact.companyId) };
      })
      .handle('contacts.releaseReplyHold', ({ id }, c) =>
        mutate(['contact'], () => {
          this.prospects.getContact(id);
          this.db
            .prepare('UPDATE contacts SET reply_hold_released_at = ?, updated_at = ? WHERE id = ?')
            .run(this.now().toISOString(), this.now().toISOString(), id);
          this.audit.record({
            actorType: 'user',
            actionType: 'contact.reply_hold_released',
            objectType: 'contact',
            objectId: id,
            correlationId: c.correlationId,
          });
          return { ok: true as const };
        }),
      )
      .handle('sideEffects.uncertain', () => ({ items: this.uncertainSends() }))
      .handle('sideEffects.resolve', ({ id, outcome }, c) =>
        mutate(['job', 'enrollment'], () => this.resolveSideEffect(id, outcome, c.correlationId)),
      )
      .handle('jobs.retry', ({ id }, c) =>
        mutate(['job', 'enrollment'], () => this.jobAction(id, 'retry', c.correlationId)),
      )
      .handle('jobs.dismiss', ({ id }, c) =>
        mutate(['job'], () => this.jobAction(id, 'dismiss', c.correlationId)),
      )
      .handle('activity.list', (p) => this.timeline.list(p))
      .handle('profiles.list', (p) => ({ items: this.browser.list(p.includeArchived) }))
      .handle('profiles.create', (p, c) => this.browser.create(p, ctx(c)))
      .handle('profiles.update', (p, c) => this.browser.rename(p.id, p.name, ctx(c)))
      .handle('profiles.archive', (p, c) => this.browser.archive(p.id, ctx(c)))
      .handle('profiles.delete', async (p, c) => {
        await this.browser.delete(p.id, p.confirmName, ctx(c));
        return { ok: true as const };
      })
      .handle('profiles.open', (p, c) => this.browser.open(p.id, p.startUrl, ctx(c)))
      .handle('profiles.close', (p, c) => this.browser.close(p.id, ctx(c)))
      .handle('profiles.focus', async (p) => {
        await this.browser.focus(p.id);
        return { ok: true as const };
      })
      .handle('profiles.check', (p) => this.browser.check(p.id));
  }

  private jobAction(id: string, action: 'retry' | 'dismiss', correlationId: string): { ok: true } {
    const done = action === 'retry' ? this.jobs.requeue(id) : this.jobs.dismiss(id);
    if (!done) throw jobNotFound();
    this.audit.record({
      actorType: 'user',
      actionType: action === 'retry' ? 'job.retried' : 'job.dismissed',
      objectType: 'job',
      objectId: id,
      correlationId,
    });
    return { ok: true };
  }

  /**
   * A person settles a send TabReach could not verify (ADR 018 \`user_confirmation\`). The run's
   * job is requeued: it then finds the ledger decided and either moves on or sends.
   */
  resolveSideEffect(id: string, outcome: 'completed' | 'not_sent', correlationId: string): { ok: true } {
    const effect = this.ledger.get(id);
    if (!effect || (effect.status !== 'unknown' && effect.status !== 'executing')) {
      throw new RpcError('CONFLICT', 'Nothing to decide', 'sideEffect.notUnknown');
    }
    // While a send job for this run is pending or running, it may be sending or reconciling right
    // now: a decision could race it into a second message (audit 3.5).
    const active = effect.workflow_run_id
      ? this.jobs.latestFor('workflow.run', 'runId', effect.workflow_run_id)
      : undefined;
    if (active && (active.status === 'pending' || active.status === 'running')) {
      throw new RpcError('CONFLICT', 'TabReach is still checking this send', 'sideEffect.busy');
    }
    if (outcome === 'completed') this.ledger.markCompleted(id, {}, 'user_confirmation');
    else this.ledger.markNotSent(id, 'user_confirmed_not_sent', 'user_confirmation');
    this.audit.record({
      actorType: 'user',
      actionType: 'side_effect.resolved',
      objectType: 'side_effect',
      objectId: id,
      payload: { outcome },
      correlationId,
    });
    if (effect.workflow_run_id) {
      const job = this.jobs.latestFor('workflow.run', 'runId', effect.workflow_run_id);
      if (job && (job.status === 'dead' || job.status === 'failed')) this.jobs.requeue(job.id);
      else if (!job) this.engine.wakeRun(effect.workflow_run_id);
    }
    return { ok: true };
  }

  /**
   * Sends whose outcome is not known and that nothing is resolving right now: unknown, or stuck in
   * executing without an active job. Listed whatever happened to their run (audit 3.5).
   */
  uncertainSends(): UncertainSend[] {
    const rows = this.db
      .prepare(
        `SELECT se.id, se.status, se.channel, se.target_normalized, se.updated_at, se.workflow_run_id,
                e.contact_id, cam.name AS campaign_name, c.first_name, c.last_name, c.full_name
         FROM side_effects se
         LEFT JOIN campaign_enrollments e ON e.id = se.scope_id
         LEFT JOIN campaigns cam ON cam.id = e.campaign_id
         LEFT JOIN contacts c ON c.id = e.contact_id
         WHERE se.status IN ('unknown', 'executing')
         ORDER BY se.updated_at`,
      )
      .all() as {
      id: string;
      status: 'unknown' | 'executing';
      channel: string;
      target_normalized: string;
      updated_at: string;
      workflow_run_id: string | null;
      contact_id: string | null;
      campaign_name: string | null;
      first_name: string | null;
      last_name: string | null;
      full_name: string | null;
    }[];
    return rows.flatMap((r) => {
      const job = r.workflow_run_id
        ? this.jobs.latestFor('workflow.run', 'runId', r.workflow_run_id)
        : undefined;
      const checking = job?.status === 'pending' || job?.status === 'running';
      if (r.status === 'executing' && checking) return []; // an ordinary send in progress
      return [
        {
          id: r.id,
          channel: r.channel,
          target: r.target_normalized,
          contactId: r.contact_id,
          contactName:
            r.full_name ?? ([r.first_name, r.last_name].filter(Boolean).join(' ') || r.target_normalized),
          campaignName: r.campaign_name,
          attemptedAt: r.updated_at,
          checking,
        },
      ];
    });
  }
}
