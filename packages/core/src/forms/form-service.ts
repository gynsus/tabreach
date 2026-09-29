import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  formFieldSchema,
  formSenderSchema,
  isPublicAddress,
  RpcError,
  sameSite,
  uuidv7,
  type ApprovalForm,
  type BrowserExecutionMode,
  type FormField,
  type FormPrepareResult,
  type FormSender,
  type Logger,
  type RpcPeer,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import { BrowserActionChannel, type BrowserDispatch } from '../browser/browser-channel.js';
import type { BrowserService } from '../browser/browser-service.js';
import type { BrowserCheckpoints } from '../browser/checkpoints.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SettingsRepository } from '../settings/settings.js';

const SENDER_KEY = 'forms.sender';
const EMPTY_SENDER: FormSender = {
  profileId: null,
  name: '',
  email: '',
  phone: '',
  company: '',
  website: '',
};
const PREPARE_TIMEOUT_MS = 180_000;
/** Product pacing for forms: one every two minutes, 40 a day (docs/14; not evasion). */
const MIN_SPACING_MS = 120_000;
const DAILY_LIMIT = 40;

export interface FormPreparationRow {
  id: string;
  workflow_run_id: string;
  message_draft_id: string;
  status: 'ready' | 'needs_human';
  reason: string | null;
  form_url: string;
  opener: string | null;
  signature: string;
  fields: string;
  challenge: string | null;
  mode: BrowserExecutionMode;
  screenshot: Uint8Array | null;
  pack_version: string;
  prepared_at: string;
  sender_key: string;
  action: string | null;
}

export type PrepareOutcome =
  | { kind: 'prepared'; preparation: FormPreparationRow }
  | { kind: 'no_form' }
  /** The person holds the sender's window, or it is busy: try again later. */
  | { kind: 'busy' }
  /** No sender profile configured: the campaign cannot use forms. */
  | { kind: 'no_sender' };

type Worker = Pick<RpcPeer, 'request'>;

/**
 * Website forms in core (docs/14, Phase 6): the sender's details, PrepareFormSubmission before
 * approval (stored with the draft it was made for), the approval hash covering exactly what goes
 * into the form, and the channel whose send is ExecuteFormSubmission through the checkpoint.
 */
export class FormService {
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
      /** Tests against the local fixture site only (see AppServicesOptions). */
      allowLocalSites?: boolean;
      resolveHost?: (host: string) => Promise<string[]>;
    },
  ) {}

  /** A company website on this machine or the local network is never opened (audit 6.5). */
  private async publicSite(url: string): Promise<boolean> {
    if (this.d.allowLocalSites) return true;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return isPublicAddress(host);
    try {
      const addresses = this.d.resolveHost
        ? await this.d.resolveHost(host)
        : (await lookup(host, { all: true })).map((a) => a.address);
      return addresses.length > 0 && addresses.every(isPublicAddress);
    } catch {
      return false;
    }
  }

  sender(): FormSender {
    return this.d.settings.get(SENDER_KEY, formSenderSchema) ?? EMPTY_SENDER;
  }

  updateSender(input: FormSender, ctx: CommandContext): FormSender {
    if (input.profileId) {
      const profile = this.d.browser.get(input.profileId);
      // The research profile renders pages without a window and signs in nowhere (ADR 027).
      if (profile.purpose === 'research' || profile.status === 'archived')
        throw RpcError.validation({ profileId: 'forms.profileUnsuitable' });
    }
    this.d.settings.set(SENDER_KEY, input);
    this.d.audit.record({
      actorType: 'user',
      actionType: 'forms.sender_updated',
      objectType: 'settings',
      correlationId: ctx.correlationId,
    });
    return this.sender();
  }

  /** Finds, maps, fills and photographs the company's contact form for this draft (nothing is sent). */
  async prepare(req: {
    workflowRunId: string;
    draftId: string;
    website: string;
    subject: string | null;
    body: string;
    /** The step's choice; a person is needed anyway for a field, a consent or a challenge. */
    stepMode: BrowserExecutionMode;
    /** Prepared several times already (a form that keeps changing): the person sends it. */
    forceAssisted: boolean;
    signal: AbortSignal;
    correlationId: string;
  }): Promise<PrepareOutcome> {
    const sender = this.sender();
    if (!sender.profileId) return { kind: 'no_sender' };
    if (!(await this.publicSite(req.website))) return { kind: 'no_form' };
    const worker = this.d.worker();
    if (!worker) throw new RpcError('UNAVAILABLE', 'Browser worker not running', 'worker.notRunning');
    const live = this.d.browser.liveSessionOf(sender.profileId);
    if (live && live.controlMode !== 'automation') return { kind: 'busy' };
    let sessionId: string;
    try {
      sessionId =
        live?.id ??
        (await this.d.browser.openSession(sender.profileId, 'automation', null, req.correlationId));
    } catch (error) {
      // Busy only while someone else uses the window; an archived sender profile cannot send.
      const detail = error instanceof RpcError ? error.problem.detail : undefined;
      if (detail === 'profile.alreadyOpen' || detail === 'session.busy' || detail === 'profile.inUse')
        return { kind: 'busy' };
      if (detail === 'profile.archived' || detail === 'profile.notFound') return { kind: 'no_sender' };
      throw error;
    }
    const [first, ...rest] = sender.name.trim().split(/\s+/);
    let result: FormPrepareResult;
    try {
      result = await worker.request(
        'form.prepare',
        {
          taskId: uuidv7(),
          sessionId,
          packId: 'web-form',
          url: req.website,
          values: {
            ...(sender.name
              ? { name: sender.name, firstName: first, lastName: rest.join(' ') || undefined }
              : {}),
            ...(sender.email ? { email: sender.email } : {}),
            ...(sender.phone ? { phone: sender.phone } : {}),
            ...(sender.company ? { company: sender.company } : {}),
            ...(sender.website ? { website: sender.website } : {}),
            ...(req.subject ? { subject: req.subject } : {}),
            message: req.body,
          },
        },
        { timeoutMs: PREPARE_TIMEOUT_MS, correlationId: req.correlationId },
      );
    } finally {
      // Nothing waits in the window between preparing and sending; the send opens it again.
      await this.d.browser
        .closeSession(sessionId)
        .catch((error: unknown) =>
          this.d.logger.warn(
            { event: 'forms.close_failed', err: error, correlationId: req.correlationId },
            'not closed',
          ),
        );
    }
    if (result.status === 'no_form') return { kind: 'no_form' };
    if (result.status === 'failed' || !result.formUrl || !result.signature) {
      throw new RpcError(
        'UNAVAILABLE',
        'The form could not be prepared',
        result.reason ?? 'form.prepareFailed',
      );
    }
    const id = uuidv7();
    this.d.db
      .prepare(
        `INSERT INTO form_preparations (id, workflow_run_id, message_draft_id, status, reason, form_url, opener,
                                        signature, fields, challenge, mode, screenshot, pack_version, prepared_at,
                                        sender_key, action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        req.workflowRunId,
        req.draftId,
        result.status,
        result.reason,
        result.formUrl,
        result.opener,
        result.signature,
        JSON.stringify(result.fields),
        result.challenge,
        // A person is needed for a field, a consent or a challenge: they press Send (FR-FRM-004).
        result.status === 'needs_human' || req.stepMode === 'assisted' || req.forceAssisted
          ? 'assisted'
          : 'auto',
        result.screenshot ? Buffer.from(result.screenshot, 'base64') : null,
        result.packVersion,
        this.d.now().toISOString(),
        this.senderKey(),
        result.action,
      );
    this.prune(req.workflowRunId, id);
    return { kind: 'prepared', preparation: this.preparation(id) as FormPreparationRow };
  }

  /** Screenshots hold the sender's form page: kept for the latest preparation, for 30 days. */
  private prune(runId: string, keepId: string): void {
    const cutoff = new Date(this.d.now().getTime() - 30 * 24 * 60 * 60_000).toISOString();
    this.d.db
      .prepare(
        `UPDATE form_preparations SET screenshot = NULL
         WHERE screenshot IS NOT NULL AND ((workflow_run_id = ? AND id != ?) OR prepared_at < ?)`,
      )
      .run(runId, keepId, cutoff);
  }

  /** Identifies the sender's settings: a preparation for other settings is prepared again. */
  senderKey(): string {
    return createHash('sha256').update(JSON.stringify(this.sender())).digest('hex').slice(0, 32);
  }

  isCurrent(p: FormPreparationRow): boolean {
    return p.sender_key === this.senderKey();
  }

  /** The form sends somewhere else than the company's site (a form service, say): shown, never auto-approved. */
  crossSite(p: FormPreparationRow): boolean {
    if (!p.action) return false;
    try {
      return !sameSite(new URL(p.action).hostname, new URL(p.form_url).hostname);
    } catch {
      return true;
    }
  }

  latestFor(runId: string): FormPreparationRow | undefined {
    return this.d.db
      .prepare(
        'SELECT * FROM form_preparations WHERE workflow_run_id = ? ORDER BY prepared_at DESC, id DESC LIMIT 1',
      )
      .get(runId) as FormPreparationRow | undefined;
  }

  preparation(id: string): FormPreparationRow | undefined {
    return this.d.db.prepare('SELECT * FROM form_preparations WHERE id = ?').get(id) as
      FormPreparationRow | undefined;
  }

  /** A challenge appeared when sending in auto: from now on the person presses Send. */
  requireAssisted(preparationId: string): void {
    this.d.db.prepare(`UPDATE form_preparations SET mode = 'assisted' WHERE id = ?`).run(preparationId);
  }

  /**
   * What an approval of a form covers: the draft, and exactly the form, its fields' values and who
   * presses Send. Any change asks for approval again.
   */
  approvalHash(draftHash: string, p: FormPreparationRow): string {
    const values = fieldsOf(p).map((f) => [f.ref, f.value]);
    return createHash('sha256')
      .update(
        JSON.stringify([
          'form-v2',
          draftHash,
          p.form_url,
          p.opener,
          p.signature,
          p.mode,
          p.action,
          p.sender_key,
          values,
        ]),
      )
      .digest('hex');
  }

  approvalForm(p: FormPreparationRow): ApprovalForm {
    return {
      formUrl: p.form_url,
      fields: fieldsOf(p),
      mode: p.mode,
      reason: p.reason,
      hasScreenshot: p.screenshot !== null,
      action: p.action,
      crossSite: this.crossSite(p),
    };
  }

  screenshotOf(approvalId: string): string | null {
    const row = this.d.db
      .prepare(
        `SELECT p.screenshot FROM approvals a
         JOIN form_preparations p ON p.workflow_run_id = a.workflow_run_id AND p.message_draft_id = a.message_draft_id
                                 AND p.prepared_at <= a.created_at
         WHERE a.id = ? ORDER BY p.prepared_at DESC, p.id DESC LIMIT 1`,
      )
      .get(approvalId) as { screenshot: Uint8Array | null } | undefined;
    if (!row) return null;
    return row.screenshot ? Buffer.from(row.screenshot).toString('base64') : null;
  }

  /** The web_form channel: ExecuteFormSubmission of the run's latest preparation, in its mode. */
  channel(): BrowserActionChannel | undefined {
    const profileId = this.sender().profileId;
    if (!profileId) return undefined;
    const dispatch: BrowserDispatch = {
      packId: 'web-form',
      packVersion: 'web-form',
      assisted: (_message, runId) => this.latestFor(runId)?.mode === 'assisted',
      run: (worker, task, options) => {
        const p = this.latestFor(task.workflowRunId);
        if (!p) throw new RpcError('CONFLICT', 'No prepared form', 'form.notPrepared');
        return worker.request(
          'form.submit',
          {
            taskId: task.taskId,
            sessionId: task.sessionId,
            packId: 'web-form',
            formUrl: p.form_url,
            opener: p.opener,
            signature: p.signature,
            fields: fieldsOf(p)
              .filter((f): f is FormField & { value: string } => f.value !== null)
              .map((f) => ({ ref: f.ref, value: f.value })),
            mode: p.mode,
          },
          options,
        );
      },
    };
    return new BrowserActionChannel('web_form', profileId, dispatch, this.d, {
      minSpacingMs: MIN_SPACING_MS,
      dailyLimit: DAILY_LIMIT,
    });
  }
}

function fieldsOf(p: FormPreparationRow): FormField[] {
  return z.array(formFieldSchema).parse(JSON.parse(p.fields));
}

/**
 * A company website as a form target: its address without query or fragment (over https when no
 * scheme was given), so `acme.com/en` stays the English site.
 */
export function websiteTarget(website: string | null): string | null {
  if (!website?.trim()) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${path}`;
  } catch {
    return null;
  }
}
