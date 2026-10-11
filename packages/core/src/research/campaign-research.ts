import type { Logger, ResearchRun } from '@tabreach/protocol';
import { researchContextHash, type ResearchService } from './research-service.js';

/** What a campaign asks research for (docs/16 "Campaign context"); empty strings for none. */
export interface ResearchContext {
  campaignId: string | null;
  goal: string;
  icp: string;
  instructions: string;
  /** Research older than this is run again before the campaign relies on it. */
  maxAgeMs: number;
  /** Also research each person (docs/16 "Research about a person"). */
  people: boolean;
}

export type ResearchNeed =
  /** Fresh research asked with this context. */
  | { kind: 'ready'; run: ResearchRun }
  /** Research with this context is running (or was just started): look again later. */
  | { kind: 'wait'; until: Date }
  /**
   * None can be had now: no website, no AI key, or it failed recently. `stale` is an older run with
   * this context, if any.
   */
  | { kind: 'unavailable'; reason: string; stale: ResearchRun | null };

/** A failed research is not tried again for every message or condition: it waits a day. */
export const FAILED_RESEARCH_BACKOFF_MS = 24 * 60 * 60_000;
/** A research still running after this is not waited for. */
export const RESEARCH_MAX_WAIT_MS = 60 * 60_000;
const RESEARCH_POLL_MS = 20_000;
/** Research that failed on a used-up AI budget is tried again after this. */
const BUDGET_RECHECK_MS = 60 * 60_000;

/**
 * Research a campaign relies on (AI messages, `research.qualification` conditions, research of all
 * its companies): a run asked with the campaign's goal, ICP and instructions, fresh enough, started
 * when there is none.
 */
export class CampaignResearch {
  constructor(private readonly d: { research: ResearchService; now: () => Date; logger: Logger }) {}

  /** `start: false` only looks (dry run, People list): nothing is started. */
  need(
    companyId: string,
    context: ResearchContext,
    correlationId: string,
    options: { start: boolean; contactId?: string | null } = { start: true },
  ): ResearchNeed {
    const now = this.d.now().getTime();
    // A run whose job is gone is failed first, so nothing waits on it (audit 4.5).
    if (options.start) this.d.research.resync();
    const hash = researchContextHash(context);
    const contactId = options.contactId ?? null;
    const { latest, completed } = this.d.research.forContext(companyId, hash, contactId);
    const fresh =
      completed?.finishedAt && now - new Date(completed.finishedAt).getTime() < context.maxAgeMs
        ? completed
        : null;
    if (
      latest &&
      (latest.status === 'pending' || latest.status === 'running') &&
      now - new Date(latest.startedAt).getTime() < RESEARCH_MAX_WAIT_MS
    ) {
      // A newer run is on its way; a fresh completed one is still good meanwhile.
      return fresh
        ? { kind: 'ready', run: fresh }
        : { kind: 'wait', until: new Date(now + RESEARCH_POLL_MS) };
    }
    if (fresh) return { kind: 'ready', run: fresh };
    const failedAt =
      latest?.status === 'failed' ? new Date(latest.finishedAt ?? latest.startedAt).getTime() : 0;
    // A used-up AI budget is the user's to raise: wait for it and try again within the hour.
    if (latest?.status === 'failed' && latest.error === 'ai.budget' && now - failedAt < BUDGET_RECHECK_MS) {
      return { kind: 'wait', until: new Date(failedAt + BUDGET_RECHECK_MS) };
    }
    if (
      latest?.status === 'failed' &&
      latest.error !== 'ai.budget' &&
      now - failedAt < FAILED_RESEARCH_BACKOFF_MS
    ) {
      return { kind: 'unavailable', reason: latest.error ?? 'research.failed', stale: completed };
    }
    if (!options.start) return { kind: 'unavailable', reason: 'research.none', stale: completed };
    try {
      this.d.research.start(
        {
          companyId,
          criteria: context.icp,
          goal: context.goal,
          instructions: context.instructions,
          campaignId: context.campaignId,
          contactId,
        },
        { correlationId },
        'system',
      );
      return { kind: 'wait', until: new Date(now + RESEARCH_POLL_MS) };
    } catch (error) {
      // No website, or no AI key: the caller goes on without it.
      const reason = (error as { problem?: { detail?: string } }).problem?.detail ?? 'research.failed';
      this.d.logger.info({ event: 'research.unavailable', companyId, reason, correlationId }, 'no research');
      return { kind: 'unavailable', reason, stale: completed };
    }
  }
}
