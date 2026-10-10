import type { DatabaseSync } from 'node:sqlite';
import { RpcError, type CustomFields } from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import type { CompanyRow } from './companies.js';
import type { ContactRow } from './contacts.js';
import { CUSTOM_PREFIX, toCsv } from './csv.js';
import { companyTags, contactTags, tagsOf } from './tags.js';
import type { CommandContext } from './prospect-service.js';

/** Column names the importer maps back automatically, so an export re-imports as "no changes". */
const BASE_HEADERS = [
  'company_name',
  'company_website',
  'company_country',
  'company_city',
  'company_timezone',
  'company_tags',
  'first_name',
  'last_name',
  'full_name',
  'email',
  'job_title',
  'linkedin_url',
  'timezone',
  'contact_tags',
] as const;

/**
 * Campaign status columns (FR-PROS-007): one row per person in the campaign, for hand-off to a CRM.
 * Statuses and stop reasons are the stable codes from docs/17, not translated labels.
 */
const CAMPAIGN_HEADERS = [
  'campaign',
  'campaign_version',
  'first_name',
  'last_name',
  'full_name',
  'email',
  'job_title',
  'linkedin_url',
  'company_name',
  'company_website',
  'status',
  'stop_reason',
  'step',
  'steps_total',
  'messages_sent',
  'outcome_unknown',
  'last_sent_at',
  'last_sent_channel',
  'last_reply_at',
  'next_action_at',
  'enrolled_at',
  'updated_at',
] as const;

interface CampaignStatusRow {
  campaign_version: number;
  steps_total: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  company_name: string | null;
  company_website: string | null;
  status: string;
  stop_reason: string | null;
  step: number;
  messages_sent: number;
  outcome_unknown: number;
  last_sent_at: string | null;
  last_sent_channel: string | null;
  last_reply_at: string | null;
  next_action_at: string | null;
  enrolled_at: string;
  updated_at: string;
}

/** CSV export of all prospects: one row per contact, plus one row per company without contacts (FR-PROS-007). */
export class ExportService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  exportProspects(ctx: CommandContext): { filename: string; csv: string; rows: number } {
    const companies = this.db
      .prepare('SELECT * FROM companies ORDER BY name_key, id')
      .all() as unknown as CompanyRow[];
    const contacts = this.db
      .prepare('SELECT * FROM contacts ORDER BY company_id, name_key, id')
      .all() as unknown as ContactRow[];
    const byId = new Map(companies.map((c) => [c.id, c]));
    const cTags = tagsOf(
      this.db,
      companyTags,
      companies.map((c) => c.id),
    );
    const pTags = tagsOf(
      this.db,
      contactTags,
      contacts.map((c) => c.id),
    );
    const linkedin = new Map(
      (
        this.db
          .prepare(`SELECT contact_id, url_original FROM contact_profile_urls WHERE channel = 'linkedin'`)
          .all() as { contact_id: string; url_original: string }[]
      ).map((r) => [r.contact_id, r.url_original]),
    );

    const parse = (json: string) => JSON.parse(json) as CustomFields;
    const companyKeys = [...new Set(companies.flatMap((c) => Object.keys(parse(c.custom_fields))))].sort();
    const contactKeys = [...new Set(contacts.flatMap((c) => Object.keys(parse(c.custom_fields))))].sort();
    const headers = [
      ...BASE_HEADERS,
      ...companyKeys.map((k) => `${CUSTOM_PREFIX.company}${k}`),
      ...contactKeys.map((k) => `${CUSTOM_PREFIX.contact}${k}`),
    ];

    const companyCells = (c: CompanyRow | undefined) => {
      const custom = c ? parse(c.custom_fields) : {};
      return {
        base: [
          c?.name ?? '',
          c?.website_url ?? '',
          c?.country ?? '',
          c?.city ?? '',
          c?.timezone ?? '',
          (c ? (cTags.get(c.id) ?? []) : []).join('; '),
        ],
        custom: companyKeys.map((k) => String(custom[k] ?? '')),
      };
    };

    const rows: string[][] = [];
    const withContacts = new Set<string>();
    for (const p of contacts) {
      const company = p.company_id ? byId.get(p.company_id) : undefined;
      if (company) withContacts.add(company.id);
      const cc = companyCells(company);
      const custom = parse(p.custom_fields);
      rows.push([
        ...cc.base,
        p.first_name ?? '',
        p.last_name ?? '',
        p.full_name ?? '',
        p.email ?? '',
        p.job_title ?? '',
        linkedin.get(p.id) ?? '',
        p.timezone ?? '',
        (pTags.get(p.id) ?? []).join('; '),
        ...cc.custom,
        ...contactKeys.map((k) => String(custom[k] ?? '')),
      ]);
    }
    for (const company of companies) {
      if (withContacts.has(company.id)) continue;
      const cc = companyCells(company);
      rows.push([...cc.base, '', '', '', '', '', '', '', '', ...cc.custom, ...contactKeys.map(() => '')]);
    }

    this.audit.record({
      actorType: 'user',
      actionType: 'export.created',
      objectType: 'export',
      payload: { rows: rows.length },
      correlationId: ctx.correlationId,
    });
    const stamp = this.now().toISOString().slice(0, 10);
    // BOM so Excel opens UTF-8 (Cyrillic) correctly.
    return {
      filename: `tabreach-prospects-${stamp}.csv`,
      csv: `\uFEFF${toCsv(headers, rows)}`,
      rows: rows.length,
    };
  }

  /** One row per person in the campaign with where they are, what was sent and whether they replied. */
  exportCampaign(campaignId: string, ctx: CommandContext): { filename: string; csv: string; rows: number } {
    const campaign = this.db.prepare('SELECT name FROM campaigns WHERE id = ?').get(campaignId) as
      { name: string } | undefined;
    if (!campaign) throw new RpcError('NOT_FOUND', 'campaign not found', 'campaign.notFound');
    const found = this.db
      .prepare(
        `SELECT v.version_number AS campaign_version,
                (SELECT COUNT(*) FROM sequence_steps s WHERE s.campaign_version_id = e.campaign_version_id)
                  AS steps_total,
                p.first_name, p.last_name, p.full_name, p.email, p.job_title,
                (SELECT u.url_original FROM contact_profile_urls u
                  WHERE u.contact_id = p.id AND u.channel = 'linkedin' LIMIT 1) AS linkedin_url,
                co.name AS company_name, co.website_url AS company_website,
                e.status, e.stop_reason, e.current_step_position AS step,
                (SELECT COUNT(*) FROM side_effects se WHERE se.scope_id = e.id AND se.status = 'completed')
                  AS messages_sent,
                (SELECT COUNT(*) FROM side_effects se WHERE se.scope_id = e.id AND se.status = 'unknown')
                  AS outcome_unknown,
                last.updated_at AS last_sent_at, last.channel AS last_sent_channel,
                e.last_reply_at, e.next_action_at, e.created_at AS enrolled_at, e.updated_at
           FROM campaign_enrollments e
           JOIN campaign_versions v ON v.id = e.campaign_version_id
           LEFT JOIN contacts p ON p.id = e.contact_id
           LEFT JOIN companies co ON co.id = COALESCE(e.company_id, p.company_id)
           LEFT JOIN side_effects last ON last.id = (
             SELECT se.id FROM side_effects se WHERE se.scope_id = e.id AND se.status = 'completed'
              ORDER BY se.updated_at DESC, se.id DESC LIMIT 1)
          WHERE e.campaign_id = ?
          ORDER BY e.created_at, e.id`,
      )
      .all(campaignId) as unknown as CampaignStatusRow[];
    const rows = found.map((r) => [
      campaign.name,
      String(r.campaign_version),
      r.first_name ?? '',
      r.last_name ?? '',
      r.full_name ?? '',
      r.email ?? '',
      r.job_title ?? '',
      r.linkedin_url ?? '',
      r.company_name ?? '',
      r.company_website ?? '',
      r.status,
      r.stop_reason ?? '',
      String(r.step),
      String(r.steps_total),
      String(r.messages_sent),
      String(r.outcome_unknown),
      r.last_sent_at ?? '',
      r.last_sent_channel ?? '',
      r.last_reply_at ?? '',
      // Only an active enrollment has a next action; a stopped one keeps a stale time.
      r.status === 'active' ? (r.next_action_at ?? '') : '',
      r.enrolled_at,
      r.updated_at,
    ]);

    this.audit.record({
      actorType: 'user',
      actionType: 'export.created',
      objectType: 'export',
      payload: { rows: rows.length, campaignId },
      correlationId: ctx.correlationId,
    });
    const stamp = this.now().toISOString().slice(0, 10);
    const slug =
      campaign.name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'campaign';
    return {
      filename: `tabreach-campaign-${slug}-${stamp}.csv`,
      csv: `\uFEFF${toCsv([...CAMPAIGN_HEADERS], rows)}`,
      rows: rows.length,
    };
  }
}
