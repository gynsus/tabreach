import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_POLICY,
  policySettingsSchema,
  type ActiveWindow,
  type PolicySettings,
  type StopReason,
} from '@tabreach/protocol';
import type { SettingsRepository } from '../settings/settings.js';
import { nextAllowedAt } from './schedule.js';

export const POLICY_SETTINGS_KEY = 'policy';
const DAY_MS = 24 * 60 * 60_000;
const TOUCH = `('executing', 'completed', 'unknown')`;

/** Outcome of a policy check: go ahead, stop the enrollment for good, or come back later. */
export type PolicyVerdict =
  | { kind: 'ok' }
  | { kind: 'stop'; reason: StopReason; rule: string }
  | { kind: 'defer'; until: Date; rule: string };

export interface PolicyTarget {
  /** The step's channel: an email's bounce says nothing about a website form. */
  channel?: string;
  /** A website form's host: a suppressed domain covers it too (audit 6.5). */
  websiteHost?: string | null;
  contactId: string;
  /** The contact's current company (not the one at enrollment time). */
  companyId: string | null;
  /** The ledger key of the action being checked: its own row is not a previous touch. */
  idempotencyKey: string;
  timeZone: string;
  window: ActiveWindow;
}

const ok: PolicyVerdict = { kind: 'ok' };

/**
 * Contact policy (FR-POL-001…006, ADR 021 §6). Pure reads: callers run it inside the transaction
 * that reserves the ledger entry, so what was checked is what gets sent.
 */
export class ContactPolicy {
  constructor(
    private readonly db: DatabaseSync,
    private readonly settings: SettingsRepository,
    private readonly now: () => Date,
  ) {}

  current(): PolicySettings {
    return this.settings.get(POLICY_SETTINGS_KEY, policySettingsSchema) ?? DEFAULT_POLICY;
  }

  update(value: PolicySettings): void {
    this.settings.set(POLICY_SETTINGS_KEY, value);
  }

  check(target: PolicyTarget): PolicyVerdict {
    const contact = this.db
      .prepare(
        `SELECT c.email_normalized, c.email_status, c.status, co.domain_normalized
         FROM contacts c LEFT JOIN companies co ON co.id = ?
         WHERE c.id = ?`,
      )
      .get(target.companyId, target.contactId) as
      | {
          email_normalized: string | null;
          email_status: string;
          status: string;
          domain_normalized: string | null;
        }
      | undefined;
    if (!contact || contact.status !== 'active')
      return { kind: 'stop', reason: 'invalid_target', rule: 'contact.inactive' };
    const byEmail = target.channel === undefined || target.channel === 'email' || target.channel === 'test';
    if (byEmail && (contact.email_status === 'bounced' || contact.email_status === 'invalid')) {
      return { kind: 'stop', reason: 'invalid_target', rule: `email.${contact.email_status}` };
    }
    const suppressed = this.suppressionRule(target, contact.email_normalized, contact.domain_normalized);
    if (suppressed) return { kind: 'stop', reason: 'suppressed', rule: suppressed };
    const hold = this.replyHold(target.contactId, target.companyId);
    if (hold) return { kind: 'stop', reason: hold, rule: `reply.${hold}` };

    const now = this.now();
    const allowed = nextAllowedAt(now, target.timeZone, target.window);
    if (allowed > now) return { kind: 'defer', until: allowed, rule: 'window' };

    const policy = this.current();
    const contactTouches = this.touches(
      'e.contact_id = ?',
      target.contactId,
      target.idempotencyKey,
      policy.contactCap.days,
    );
    const contactUntil = capUntil(contactTouches, policy.contactCap);
    if (contactUntil) return { kind: 'defer', until: contactUntil, rule: 'cap.contact' };
    if (target.companyId) {
      const companyTouches = this.touches(
        'e.contact_id IN (SELECT id FROM contacts WHERE company_id = ?)',
        target.companyId,
        target.idempotencyKey,
        policy.companyCap.days,
      );
      const companyUntil = capUntil(companyTouches, policy.companyCap);
      if (companyUntil) return { kind: 'defer', until: companyUntil, rule: 'cap.company' };
    }
    return ok;
  }

  /** Pacing of a channel account: minimum spacing between sends and a rolling 24-hour limit. */
  checkChannel(
    channel: { channel: string; accountId: string | null; minSpacingMs: number; dailyLimit: number | null },
    idempotencyKey: string,
  ): PolicyVerdict {
    const now = this.now();
    const recent = this.db
      .prepare(
        `SELECT updated_at FROM side_effects
         WHERE channel = ? AND channel_account_id IS ? AND status IN ${TOUCH} AND idempotency_key != ?
           AND updated_at > ?
         ORDER BY updated_at`,
      )
      .all(
        channel.channel,
        channel.accountId,
        idempotencyKey,
        new Date(now.getTime() - DAY_MS).toISOString(),
      ) as {
      updated_at: string;
    }[];
    const last = recent.at(-1);
    if (last && channel.minSpacingMs > 0) {
      const next = new Date(new Date(last.updated_at).getTime() + channel.minSpacingMs);
      if (next > now) return { kind: 'defer', until: next, rule: 'channel.spacing' };
    }
    if (channel.dailyLimit !== null && recent.length >= channel.dailyLimit) {
      const oldest = recent[recent.length - channel.dailyLimit];
      return {
        kind: 'defer',
        until: new Date(new Date(oldest?.updated_at ?? now).getTime() + DAY_MS),
        rule: 'channel.daily',
      };
    }
    return ok;
  }

  /**
   * A reply stops more than the sequence it answered: nobody writes to that person again — nor,
   * with the company stop on, to their colleagues — until the user allows it on the contact
   * (audit 3.5). Replies from before that moment no longer count.
   */
  replyHold(contactId: string, companyId: string | null): 'replied' | 'company_replied' | null {
    const released =
      (
        this.db.prepare('SELECT reply_hold_released_at AS at FROM contacts WHERE id = ?').get(contactId) as
          { at: string | null } | undefined
      )?.at ?? '';
    const own = this.db
      .prepare(
        `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.contact_id = ? AND m.direction = 'inbound' AND m.classification = 'reply' AND m.created_at > ?
         LIMIT 1`,
      )
      .get(contactId, released);
    if (own) return 'replied';
    if (!companyId || !this.current().companyStopOnReply) return null;
    const colleague = this.db
      .prepare(
        `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.direction = 'inbound' AND m.classification = 'reply' AND m.created_at > ?
           AND (
             (c.contact_id IN (SELECT id FROM contacts WHERE company_id = ?) AND m.match_strength != 'domain_only')
             OR (c.contact_id IS NULL AND c.company_id = ? AND m.review_status = 'confirmed')
           )
         LIMIT 1`,
      )
      .get(released, companyId, companyId);
    return colleague ? 'company_replied' : null;
  }

  private suppressionRule(
    target: PolicyTarget,
    email: string | null,
    companyDomain: string | null,
  ): string | null {
    const checks: [string, string, string[]][] = [];
    if (email) checks.push(['email', 'suppression.email', [email]]);
    const domains = [
      ...domainAndParents(email?.split('@')[1] ?? null),
      ...domainAndParents(companyDomain),
      ...domainAndParents(target.websiteHost?.replace(/^www\./, '') ?? null),
    ];
    if (domains.length > 0) checks.push(['domain', 'suppression.domain', domains]);
    if (target.companyId) checks.push(['company', 'suppression.company', [target.companyId]]);
    const profiles = this.db
      .prepare('SELECT channel, url_normalized FROM contact_profile_urls WHERE contact_id = ?')
      .all(target.contactId) as { channel: string; url_normalized: string }[];
    if (profiles.length > 0) {
      checks.push([
        'profile_url',
        'suppression.profile',
        profiles.map((p) => `${p.channel}:${p.url_normalized}`),
      ]);
    }
    for (const [kind, rule, values] of checks) {
      const hit = this.db
        .prepare(
          `SELECT 1 FROM suppressions WHERE kind = ? AND value_normalized IN (${values.map(() => '?').join(', ')}) LIMIT 1`,
        )
        .get(kind, ...values);
      if (hit) return rule;
    }
    return null;
  }

  private touches(where: string, id: string, excludeKey: string, days: number): string[] {
    const since = new Date(this.now().getTime() - days * DAY_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT se.updated_at FROM side_effects se
         JOIN campaign_enrollments e ON e.id = se.scope_id
         WHERE ${where} AND se.status IN ${TOUCH} AND se.idempotency_key != ? AND se.updated_at > ?
         ORDER BY se.updated_at`,
      )
      .all(id, excludeKey, since) as { updated_at: string }[];
    return rows.map((r) => r.updated_at);
  }
}

/** `mail.acme.com` → mail.acme.com, acme.com: a domain suppression covers its subdomains. */
export function domainAndParents(domain: string | null): string[] {
  if (!domain) return [];
  const labels = domain.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** When a cap of `touches` per `days` lets the next touch through, or null if it already does. */
function capUntil(touchTimes: string[], cap: { touches: number; days: number }): Date | null {
  if (touchTimes.length < cap.touches) return null;
  const blocking = touchTimes[touchTimes.length - cap.touches] as string;
  return new Date(new Date(blocking).getTime() + cap.days * DAY_MS);
}
