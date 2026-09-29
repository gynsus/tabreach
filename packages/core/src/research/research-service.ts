import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  uuidv7,
  type ChangedEntity,
  type Logger,
  type ResearchDetail,
  type ResearchRun,
} from '@tabreach/protocol';
import { z } from 'zod';
import { AiGateway } from '../ai/gateway.js';
import { AiError } from '../ai/provider.js';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import type { Http } from '../email/gmail.js';
import { PermanentError, RetryableError, type JobType } from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import { extractPage } from './extract.js';
import { PageFetcher } from './fetcher.js';
import { synthesizeResearch, type Synthesis } from './synthesize.js';
import { quoteFound } from './verify.js';

export const JOB_RESEARCH = 'research.run';
const MAX_PAGES = 6;
/** Text per page sent to the model; the whole page is kept as evidence. */
const MAX_CHARS_PER_PAGE = 8_000;
const EXTRACTOR = 'static-readability';

/** Pages that usually say what a company does, who works there and what changes (docs/16). */
const LIKELY =
  /(about|company|who-we-are|team|people|careers?|jobs|vacanc|hiring|news|blog|press|services?|products?|solutions?|customers|clients|contact|o-nas|o-kompanii|komanda|vakansii|kariera|novosti|uslugi|produkty|kontakty|о нас|о компании|команда|вакансии|карьера|новости|услуги|продукты|решения|клиенты|контакты)/i;

interface RunRow {
  id: string;
  company_id: string;
  status: ResearchRun['status'];
  error: string | null;
  criteria: string | null;
  summary: string | null;
  qualification: ResearchRun['qualification'];
  qualification_reason: string | null;
  reason_to_contact: string | null;
  missing_information: string;
  template: string | null;
  model: string | null;
  pages_fetched: number;
  pages_skipped: number;
  correlation_id: string;
  started_at: string;
  finished_at: string | null;
}

/**
 * Research runs (docs/16): fetch the company's own pages (robots.txt, same site, bounded), keep
 * their text as evidence, let AI synthesise, and keep a fact only if its quote is really on the
 * page. Evidence is stored once per content hash.
 */
export class ResearchService {
  private readonly fetcher: PageFetcher;

  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      audit: AuditLog;
      ai: AiGateway;
      jobs: JobQueue;
      http: Http;
      logger: Logger;
      changed: (entities: ChangedEntity[]) => void;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.fetcher = new PageFetcher(d.http, d.sleep);
  }

  jobTypes(): JobType<never>[] {
    const type: JobType<{ runId: string }> = {
      type: JOB_RESEARCH,
      payload: z.object({ runId: z.uuid() }),
      sideEffecting: false,
      concurrency: 2,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: 6 * 60 * 60_000,
      handler: async ({ runId }, ctx) => {
        try {
          await this.run(runId, ctx.signal);
        } catch (error) {
          // The job gives up after this: the run must not stay "running" for ever.
          const final = error instanceof PermanentError || ctx.attempt >= MAX_ATTEMPTS;
          if (final && !ctx.signal.aborted && this.isOpen(runId)) this.fail(runId, failureKey(error));
          throw error;
        }
      },
    };
    return [type] as unknown as JobType<never>[];
  }

  start(
    input: { companyId: string; criteria?: string | null | undefined },
    ctx: CommandContext,
  ): ResearchRun {
    return transaction(this.d.db, () => {
      const company = this.company(input.companyId);
      if (!siteUrl(company))
        throw RpcError.validation({ website: 'research.noWebsite' }, 'research.noWebsite');
      if (!this.d.ai.settings().keySet) throw new RpcError('CONFLICT', 'No AI key', 'ai.no_key');
      const id = uuidv7();
      this.d.db
        .prepare(
          `INSERT INTO research_runs (id, company_id, status, criteria, correlation_id, started_at) VALUES (?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          input.companyId,
          input.criteria?.trim() || null,
          ctx.correlationId,
          this.d.now().toISOString(),
        );
      this.d.jobs.enqueue(
        JOB_RESEARCH,
        { runId: id },
        { dedupeKey: `research:${id}`, correlationId: ctx.correlationId },
      );
      this.d.audit.record({
        actorType: 'user',
        actionType: 'research.started',
        objectType: 'research',
        objectId: id,
        payload: { companyId: input.companyId },
        correlationId: ctx.correlationId,
      });
      return this.toDto(this.row(id));
    });
  }

  list(companyId: string): ResearchRun[] {
    return (
      this.d.db
        .prepare('SELECT * FROM research_runs WHERE company_id = ? ORDER BY started_at DESC')
        .all(companyId) as unknown as RunRow[]
    ).map((r) => this.toDto(r));
  }

  get(id: string): ResearchDetail {
    const run = this.row(id);
    const facts = this.d.db
      .prepare('SELECT * FROM research_facts WHERE research_run_id = ? ORDER BY position')
      .all(id) as {
      id: string;
      kind: 'fact' | 'inference';
      claim: string;
      quote: string | null;
      evidence_id: string | null;
      verified: number;
      based_on: string;
    }[];
    const evidence = this.d.db
      .prepare(
        `SELECT e.id, e.url, e.title, e.captured_at FROM evidence e JOIN research_run_evidence re ON re.evidence_id = e.id
         WHERE re.research_run_id = ? ORDER BY e.captured_at`,
      )
      .all(id) as { id: string; url: string; title: string | null; captured_at: string }[];
    return {
      ...this.toDto(run),
      facts: facts.map((f) => ({
        id: f.id,
        kind: f.kind,
        claim: f.claim,
        quote: f.quote,
        evidenceId: f.evidence_id,
        verified: f.verified === 1,
        basedOn: JSON.parse(f.based_on) as string[],
      })),
      evidence: evidence.map((e) => ({ id: e.id, url: e.url, title: e.title, capturedAt: e.captured_at })),
    };
  }

  /** Verified facts of the company's latest completed run, for drafting (Phase 4c). */
  latestFacts(
    companyId: string,
  ): { runId: string; facts: { id: string; claim: string; quote: string }[] } | null {
    const run = this.d.db
      .prepare(
        `SELECT id FROM research_runs WHERE company_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(companyId) as { id: string } | undefined;
    if (!run) return null;
    const facts = this.d.db
      .prepare(
        `SELECT id, claim, quote FROM research_facts WHERE research_run_id = ? AND kind = 'fact' AND verified = 1 ORDER BY position`,
      )
      .all(run.id) as { id: string; claim: string; quote: string }[];
    return { runId: run.id, facts };
  }

  async run(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.row(runId);
    if (run.status === 'completed' || run.status === 'failed') return;
    this.update(runId, { status: 'running' });
    this.d.changed(['research']);
    const company = this.company(run.company_id);
    const start = siteUrl(company);
    if (!start) return this.fail(runId, 'research.noWebsite');
    const site = start.hostname;

    // Collect: the start page, then likely pages it links to on the same site.
    const pages: { evidenceId: string; url: string; title: string | null; text: string }[] = [];
    let skipped = 0;
    const queue = [start.toString()];
    const seen = new Set<string>();
    while (queue.length > 0 && pages.length < MAX_PAGES) {
      const url = queue.shift() as string;
      const key = url.replace(/#.*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      const fetched = await this.fetcher.fetch(url, site, signal);
      if (!fetched.ok) {
        skipped++;
        continue;
      }
      const page = extractPage(fetched.html, fetched.url);
      if (page.text.length < 40) {
        skipped++;
        continue;
      }
      pages.push({
        evidenceId: this.storeEvidence(runId, fetched.url, page.title, page.text),
        url: fetched.url,
        title: page.title,
        text: page.text,
      });
      if (pages.length === 1) {
        for (const link of page.links) {
          if (queue.length >= MAX_PAGES * 2) break;
          const u = new URL(link.url);
          if (u.hostname.replace(/^www\./, '') !== site.replace(/^www\./, '')) continue;
          if (LIKELY.test(decodeURIComponent(u.pathname)) || LIKELY.test(link.text)) queue.push(u.toString());
        }
      }
    }
    this.update(runId, { pages_fetched: pages.length, pages_skipped: skipped });
    if (pages.length === 0) return this.fail(runId, 'research.noPages');

    let synthesis: Synthesis;
    try {
      synthesis = await this.d.ai.run(
        synthesizeResearch,
        {
          company: { name: company.name, site },
          criteria: run.criteria,
          pages: pages.map((p, i) => ({
            ref: `E${i + 1}`,
            url: p.url,
            title: p.title,
            text: p.text.slice(0, MAX_CHARS_PER_PAGE),
          })),
          nonce: AiGateway.nonce(),
        },
        { correlationId: run.correlation_id, signal },
      );
    } catch (error) {
      if (error instanceof AiError) {
        if (error.retryable) throw new RetryableError(`ai_${error.kind}`);
        return this.fail(runId, `ai.${error.kind}`);
      }
      throw error;
    }
    this.storeSynthesis(runId, synthesis, pages);
    this.d.changed(['research', 'activity']);
  }

  /** Keeps every claim, but only a quote found on its page makes a fact (docs/15 "Grounding verification"). */
  private storeSynthesis(
    runId: string,
    s: Synthesis,
    pages: { evidenceId: string; url: string; text: string }[],
  ): void {
    transaction(this.d.db, () => {
      const ts = this.d.now().toISOString();
      const insert = this.d.db.prepare(
        `INSERT INTO research_facts (id, research_run_id, position, kind, claim, evidence_id, quote, verified, based_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const factIds: (string | null)[] = [];
      let position = 0;
      let verifiedCount = 0;
      for (const f of s.facts) {
        const page = pageForRef(f.evidenceRef, pages);
        const verified = page !== undefined && quoteFound(f.quote, page.text);
        const id = uuidv7();
        insert.run(
          id,
          runId,
          position++,
          'fact',
          f.claim,
          page?.evidenceId ?? null,
          f.quote,
          verified ? 1 : 0,
          '[]',
          ts,
        );
        factIds.push(verified ? id : null);
        if (verified) verifiedCount++;
      }
      for (const inference of s.inferences) {
        const basis = inference.basedOnFacts.map((i) => factIds[i]).filter((id): id is string => Boolean(id));
        // An inference needs at least one verified fact under it.
        if (basis.length === 0) continue;
        insert.run(
          uuidv7(),
          runId,
          position++,
          'inference',
          inference.claim,
          null,
          null,
          1,
          JSON.stringify(basis),
          ts,
        );
      }
      this.update(runId, {
        status: 'completed',
        summary: s.companySummary,
        qualification: s.qualification,
        qualification_reason: s.qualificationReason,
        reason_to_contact: s.reasonToContact,
        missing_information: JSON.stringify(s.missingInformation),
        template: `${synthesizeResearch.key}@${synthesizeResearch.version}`,
        model: this.d.ai.settings().models.research,
        finished_at: ts,
      });
      const run = this.row(runId);
      this.d.audit.record({
        actorType: 'ai',
        actionType: 'research.completed',
        objectType: 'research',
        objectId: runId,
        payload: { facts: s.facts.length, verified: verifiedCount, qualification: s.qualification },
        correlationId: run.correlation_id,
      });
    });
  }

  private storeEvidence(runId: string, url: string, title: string | null, text: string): string {
    const hash = createHash('sha256').update(text).digest('hex');
    const existing = this.d.db.prepare('SELECT id FROM evidence WHERE content_hash = ?').get(hash) as
      { id: string } | undefined;
    const id = existing?.id ?? uuidv7();
    if (!existing) {
      this.d.db
        .prepare(
          'INSERT INTO evidence (id, url, title, content_hash, text, extractor, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, url, title, hash, text, EXTRACTOR, this.d.now().toISOString());
    }
    this.d.db
      .prepare('INSERT OR IGNORE INTO research_run_evidence (research_run_id, evidence_id) VALUES (?, ?)')
      .run(runId, id);
    return id;
  }

  /** Runs whose job is gone (it died before failures were recorded on the run) are failed on start. */
  resync(): void {
    const orphans = this.d.db
      .prepare(
        `SELECT r.id FROM research_runs r WHERE r.status IN ('pending', 'running') AND NOT EXISTS (
           SELECT 1 FROM jobs j WHERE j.type = ? AND j.status IN ('pending', 'running')
             AND json_extract(j.payload, '$.runId') = r.id)`,
      )
      .all(JOB_RESEARCH) as { id: string }[];
    for (const { id } of orphans) this.fail(id, 'research.failed');
  }

  private isOpen(runId: string): boolean {
    const status = this.row(runId).status;
    return status === 'pending' || status === 'running';
  }

  private fail(runId: string, error: string): void {
    this.update(runId, { status: 'failed', error, finished_at: this.d.now().toISOString() });
    const run = this.row(runId);
    this.d.audit.record({
      actorType: 'system',
      actionType: 'research.failed',
      objectType: 'research',
      objectId: runId,
      status: 'failed',
      payload: { error },
      correlationId: run.correlation_id,
    });
    this.d.changed(['research', 'activity']);
    if (error.startsWith('ai.') && error !== 'ai.no_key' && error !== 'ai.budget')
      throw new PermanentError(error);
  }

  private update(id: string, fields: Partial<RunRow>): void {
    const entries = Object.entries(fields);
    this.d.db
      .prepare(`UPDATE research_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), id);
  }

  private row(id: string): RunRow {
    const row = this.d.db.prepare('SELECT * FROM research_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'Research not found', 'research.notFound');
    return row;
  }

  private company(id: string) {
    const c = this.d.db
      .prepare('SELECT id, name, website_url, domain_normalized FROM companies WHERE id = ?')
      .get(id) as
      { id: string; name: string; website_url: string | null; domain_normalized: string | null } | undefined;
    if (!c) throw new RpcError('NOT_FOUND', 'Company not found', 'company.notFound');
    return c;
  }

  private toDto(r: RunRow): ResearchRun {
    return {
      id: r.id,
      companyId: r.company_id,
      status: r.status,
      error: r.error,
      criteria: r.criteria,
      summary: r.summary,
      qualification: r.qualification,
      qualificationReason: r.qualification_reason,
      reasonToContact: r.reason_to_contact,
      missingInformation: JSON.parse(r.missing_information) as string[],
      template: r.template,
      model: r.model,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      pagesFetched: r.pages_fetched,
      pagesSkipped: r.pages_skipped,
    };
  }
}

const MAX_ATTEMPTS = 3;

/** Where research starts: the website as entered (a scheme added when missing), else the domain. */
export function siteUrl(company: {
  website_url: string | null;
  domain_normalized: string | null;
}): URL | null {
  for (const raw of [company.website_url, company.domain_normalized]) {
    const text = raw?.trim();
    if (!text) continue;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')) return url;
    } catch {
      // not a URL: try the next candidate
    }
  }
  return null;
}

function failureKey(error: unknown): string {
  const errorClass =
    error instanceof RetryableError || error instanceof PermanentError ? error.errorClass : '';
  return errorClass.startsWith('ai_') ? `ai.${errorClass.slice(3)}` : 'research.failed';
}

/** The page a fact cites: "E2", also "E2 https://…" or the page's URL, as models write it. */
export function pageForRef<P extends { url: string }>(ref: string, pages: P[]): P | undefined {
  const n = /\bE(\d+)\b/.exec(ref)?.[1];
  if (n !== undefined) return pages[Number(n) - 1];
  const url = ref.trim();
  return pages.find((p) => p.url === url || p.url === `${url}/`);
}
