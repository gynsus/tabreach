import type { DatabaseSync } from 'node:sqlite';
import type { ActionEvent, ActivityCategory, TimelineEntry } from '@tabreach/protocol';

/** Action-type prefixes of each activity category. */
const CATEGORIES: Record<ActivityCategory, string[]> = {
  messages: ['message.', 'draft.', 'approval.'],
  campaigns: ['campaign.', 'enrollment.'],
  prospects: ['contact.', 'company.', 'import.', 'export.', 'suppression.'],
  research: ['research.'],
  settings: ['ai.', 'account.', 'policy.', 'job.', 'side_effect.'],
};
const MAX_BODY = 5_000;

interface Row {
  id: string;
  correlation_id: string;
  causation_id: string | null;
  actor_type: ActionEvent['actorType'];
  action_type: string;
  object_type: string | null;
  object_id: string | null;
  status: string;
  payload_redacted: string;
  created_at: string;
  contact_id: string | null;
  company_id: string | null;
  campaign_id: string | null;
}

/**
 * Every audit event linked to the contact, company and campaign it concerns (FR-AUD-002,
 * docs/20 "Action timeline"). The trail stores ids only (ADR 022), so the links and names come from
 * the current records: through the enrollment, approval, conversation, research run or send the
 * event is about. A record that was deleted simply no longer resolves.
 */
export class TimelineService {
  constructor(private readonly db: DatabaseSync) {}

  list(filter: {
    contactId?: string | undefined;
    companyId?: string | undefined;
    campaignId?: string | undefined;
    category?: ActivityCategory | undefined;
    before?: { createdAt: string; id: string } | undefined;
    limit: number;
  }): { items: TimelineEntry[]; hasMore: boolean } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.contactId) {
      where.push('contact_id = ?');
      params.push(filter.contactId);
    }
    if (filter.companyId) {
      where.push('company_id = ?');
      params.push(filter.companyId);
    }
    if (filter.campaignId) {
      where.push('campaign_id = ?');
      params.push(filter.campaignId);
    }
    if (filter.category) {
      const prefixes = CATEGORIES[filter.category];
      where.push(`(${prefixes.map(() => 'action_type LIKE ?').join(' OR ')})`);
      params.push(...prefixes.map((p) => `${p}%`));
    }
    if (filter.before) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(filter.before.createdAt, filter.before.createdAt, filter.before.id);
    }
    const rows = this.db
      .prepare(
        `WITH linked AS (
           SELECT ev.*,
             COALESCE(ct.id, en.contact_id, ap_en.contact_id, cv.contact_id, se_en.contact_id) AS contact_id,
             COALESCE(co.id, en.company_id, ap_en.company_id, cv.company_id, se_en.company_id, rr.company_id,
                      ct.company_id) AS company_id,
             COALESCE(cam.id, en.campaign_id, ap_en.campaign_id, se_en.campaign_id) AS campaign_id
           FROM action_events ev
           LEFT JOIN contacts ct ON ev.object_type = 'contact' AND ct.id = ev.object_id
           LEFT JOIN companies co ON ev.object_type = 'company' AND co.id = ev.object_id
           LEFT JOIN campaigns cam ON ev.object_type = 'campaign' AND cam.id = ev.object_id
           LEFT JOIN campaign_enrollments en ON ev.object_type = 'enrollment' AND en.id = ev.object_id
           LEFT JOIN approvals ap ON ev.object_type = 'approval' AND ap.id = ev.object_id
           LEFT JOIN campaign_enrollments ap_en ON ap_en.id = ap.campaign_enrollment_id
           LEFT JOIN conversations cv ON ev.object_type = 'conversation' AND cv.id = ev.object_id
           LEFT JOIN research_runs rr ON ev.object_type = 'research' AND rr.id = ev.object_id
           LEFT JOIN side_effects se ON ev.object_type = 'side_effect' AND se.id = ev.object_id
           LEFT JOIN campaign_enrollments se_en ON se_en.id = se.scope_id
         )
         SELECT * FROM linked ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, filter.limit + 1) as unknown as Row[];
    const hasMore = rows.length > filter.limit;
    return { items: rows.slice(0, filter.limit).map((r) => this.entry(r)), hasMore };
  }

  private entry(r: Row): TimelineEntry {
    const payload = JSON.parse(r.payload_redacted) as Record<string, unknown>;
    return {
      id: r.id,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      actorType: r.actor_type,
      actionType: r.action_type,
      objectType: r.object_type,
      objectId: r.object_id,
      status: r.status,
      payload,
      createdAt: r.created_at,
      contact: r.contact_id ? this.contactRef(r.contact_id) : null,
      company: r.company_id ? this.name('companies', r.company_id) : null,
      campaign: r.campaign_id ? this.name('campaigns', r.campaign_id) : null,
      message: this.message(r.action_type, r.status, payload),
    };
  }

  private contactRef(id: string): TimelineEntry['contact'] {
    const c = this.db
      .prepare('SELECT first_name, last_name, full_name, email FROM contacts WHERE id = ?')
      .get(id) as
      | {
          first_name: string | null;
          last_name: string | null;
          full_name: string | null;
          email: string | null;
        }
      | undefined;
    if (!c) return null;
    const name = c.full_name ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '—');
    return { id, name };
  }

  private name(table: 'companies' | 'campaigns', id: string): { id: string; name: string } | null {
    const row = this.db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as
      { name: string } | undefined;
    return row ? { id, name: row.name } : null;
  }

  /** The text behind a message event: what was written, sent or received. */
  private message(actionType: string, status: string, p: Record<string, unknown>): TimelineEntry['message'] {
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    let row: { subject: string | null; body: string | null } | undefined;
    let direction: 'inbound' | 'outbound' = 'outbound';
    // One text per message: at its completed send, when AI wrote or a person edited it, when it came in.
    if (actionType === 'message.send' && status === 'completed' && str(p.runId)) {
      row = this.db
        .prepare(
          'SELECT subject, body FROM message_drafts WHERE workflow_run_id = ? ORDER BY version DESC LIMIT 1',
        )
        .get(str(p.runId)) as typeof row;
    } else if ((actionType === 'draft.generated' || actionType === 'draft.revised') && str(p.draftId)) {
      row = this.db
        .prepare('SELECT subject, body FROM message_drafts WHERE id = ?')
        .get(str(p.draftId)) as typeof row;
    } else if (actionType === 'message.received' && str(p.messageId)) {
      row = this.db
        .prepare('SELECT subject, body FROM messages WHERE id = ?')
        .get(str(p.messageId)) as typeof row;
      direction = 'inbound';
    }
    if (!row) return null;
    return { subject: row.subject, body: (row.body ?? '').slice(0, MAX_BODY), direction };
  }
}
