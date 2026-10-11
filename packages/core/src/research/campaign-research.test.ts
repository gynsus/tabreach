import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import type { CampaignConfigInput } from '@tabreach/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

const DAY = 24 * 60 * 60_000;

const GOAL = 'Book short calls with heads of operations about warehouse automation.';
const ICP = 'Robotics or logistics companies in Germany. Not: consultancies.';
const LOOK_FOR = 'New offices and sales hires.';

const synthesis = (qualification: string) => ({
  input: {
    companySummary: 'Acme Robotics builds picking robots for warehouses.',
    facts: [
      {
        claim: 'Opened a Berlin office in March 2026.',
        evidenceRef: 'E1',
        quote: 'In March 2026 we opened our new Berlin office',
      },
    ],
    inferences: [],
    qualification,
    qualificationReason: 'Warehouse robots in Germany.',
    reasonToContact: 'A new Berlin office.',
    missingInformation: [],
  },
});

/** Research with the campaign's goal and ICP (docs/16 "Campaign context", FR-RES-001). */
describe('campaign research', () => {
  let fixtures: FixtureServer;
  let h: Harness;
  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(() => fixtures.close());
  beforeEach(async () => {
    h = await new Harness().open();
    h.webHttp = (url, init) => {
      const u = new URL(url);
      if (u.hostname !== 'acme.test') return Promise.reject(new Error(`unexpected host ${u.hostname}`));
      return fetch(new URL(`acme${u.pathname}`, fixtures.url), init).then((res) => {
        const copy = new Response(res.body, { status: res.status, headers: res.headers });
        Object.defineProperty(copy, 'url', { value: url });
        return copy;
      });
    };
    await h.services.ai.setKey('anthropic', 'sk-ant-test-0123456789abcdef', ctx());
  });
  afterEach(() => h.close());

  const acme = () =>
    h.services.prospects.createCompany({ name: 'Acme Robotics', website: 'https://acme.test/' }, ctx()).id;
  const person = (companyId: string | null, name = 'Bob') =>
    h.services.prospects.createContact(
      { firstName: name, email: `${name.toLowerCase()}@acme.test`, ...(companyId ? { companyId } : {}) },
      ctx(),
    ).id;

  const config = (over: Partial<CampaignConfigInput> = {}): CampaignConfigInput => ({
    steps: [
      {
        type: 'condition',
        delaySeconds: 0,
        conditions: [{ field: 'research.qualification', op: 'eq', value: 'match' }],
        onFalse: 'stop',
      },
      {
        type: 'send_message',
        channel: 'test',
        executionMode: 'auto',
        delaySeconds: 0,
        subject: 'Hi',
        body: 'Hello',
      },
    ],
    timezone: 'UTC',
    window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
    goal: GOAL,
    icp: ICP,
    researchInstructions: LOOK_FOR,
    ...over,
  });

  function launch(c: CampaignConfigInput, contacts: string[]): string {
    const { campaigns } = h.services;
    const id = campaigns.create({ name: 'Research', config: c }, ctx()).id;
    campaigns.launch(id, ctx());
    if (contacts.length) campaigns.enroll(id, contacts, ctx());
    return id;
  }
  const people = (id: string) => h.services.campaigns.listEnrollments(id, { limit: 10, offset: 0 }).items;
  const runs = () =>
    h.db.prepare('SELECT * FROM research_runs ORDER BY started_at').all() as Record<string, unknown>[];
  /** Lets the condition step look again after research ran. */
  const settle = async () => {
    await h.run();
    h.clock.advance(30_000);
    await h.run();
  };

  it('a research condition waits for research asked with the goal, ICP and what to look for, then lets a match through', async () => {
    h.anthropic.answer(synthesis('match'));
    const id = launch(config(), [person(acme())]);
    await settle();

    const [run] = runs();
    expect(run).toMatchObject({
      campaign_id: id,
      goal: GOAL,
      criteria: ICP,
      instructions: LOOK_FOR,
      status: 'completed',
    });
    const prompt = h.anthropic.requests[0]?.user ?? '';
    expect(prompt).toContain(`Campaign goal: ${GOAL}`);
    expect(prompt).toContain(`Criteria: ${ICP}`);
    expect(prompt).toContain(`What to look for: ${LOOK_FOR}`);
    expect(people(id)[0]).toMatchObject({ status: 'active', stepPosition: 2, qualification: 'match' });
    expect(h.services.approvals.pending()).toHaveLength(1);
  });

  it('a company that does not fit stops the person', async () => {
    h.anthropic.answer(synthesis('not_match'));
    const id = launch(config(), [person(acme())]);
    await settle();
    expect(people(id)[0]).toMatchObject({
      status: 'stopped',
      stopReason: 'condition_not_met',
      qualification: 'not_match',
    });
    expect(h.services.approvals.pending()).toHaveLength(0);
  });

  it('without a website there is no research: the person stops and the reason says why', async () => {
    const noSite = h.services.prospects.createCompany({ name: 'No Site GmbH' }, ctx()).id;
    const id = launch(config(), [person(noSite)]);
    await settle();
    expect(people(id)[0]).toMatchObject({ status: 'stopped', stopReason: 'condition_not_met' });
    const stopped = h.services.audit
      .list({ objectType: 'enrollment', limit: 20 })
      .find((a) => a.actionType === 'enrollment.stopped');
    expect(stopped?.payload).toMatchObject({ reason: 'condition_not_met', rule: 'research.noWebsite' });
    expect(h.anthropic.requests).toHaveLength(0);
  });

  it('research is reused while fresh and with the same context; a new ICP or age asks again', async () => {
    const company = acme();
    h.anthropic.answer(synthesis('match'), synthesis('match'), synthesis('match'));
    launch(config(), [person(company, 'Bob')]);
    await settle();
    // A second person at the same company, in another campaign with the same goal and ICP.
    launch(config(), [person(company, 'Ann')]);
    await settle();
    expect(runs()).toHaveLength(1);

    launch(config({ icp: 'Only companies in Austria.' }), [person(company, 'Eve')]);
    await settle();
    expect(runs()).toHaveLength(2);

    h.clock.advance(8 * DAY);
    launch(config({ researchMaxAgeDays: 7 }), [person(company, 'Max')]);
    await settle();
    expect(runs()).toHaveLength(3);
  });

  it('“Research companies” queues research for each company once and says what it did', async () => {
    const company = acme();
    const noSite = h.services.prospects.createCompany({ name: 'No Site GmbH' }, ctx()).id;
    // A long delay keeps everyone waiting at the first step.
    const id = launch(
      config({
        steps: [
          {
            type: 'send_message',
            channel: 'test',
            executionMode: 'auto',
            delaySeconds: 30 * 86_400,
            subject: 'Hi',
            body: 'Hello',
          },
        ],
      }),
      [person(company, 'Bob'), person(company, 'Ann'), person(noSite, 'Eve'), person(null, 'Lone')],
    );
    expect(h.services.campaigns.researchCompanies(id, ctx())).toEqual({
      companies: 2,
      withoutCompany: 1,
      fresh: 0,
      queued: 1,
      noWebsite: 1,
      failed: 0,
    });
    // Asking again while it runs starts nothing new.
    expect(h.services.campaigns.researchCompanies(id, ctx())).toMatchObject({ queued: 1 });
    expect(runs()).toHaveLength(1);
    h.anthropic.answer(synthesis('possible_match'));
    await h.run();
    expect(h.services.campaigns.researchCompanies(id, ctx())).toMatchObject({ fresh: 1, queued: 0 });
    expect(people(id).map((p) => p.qualification)).toEqual(['possible_match', 'possible_match', null, null]);
  });

  it('a research condition needs an ICP and an AI key to launch', async () => {
    const { campaigns } = h.services;
    const noIcp = campaigns.create({ name: 'No ICP', config: config({ icp: '' }) }, ctx()).id;
    expect(() => campaigns.launch(noIcp, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.conditions': 'campaign.icpRequired' } }),
      }),
    );
    h.services.ai.removeKey('anthropic', ctx());
    const noKey = campaigns.create({ name: 'No key', config: config() }, ctx()).id;
    expect(() => campaigns.launch(noKey, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.conditions': 'ai.keyRequired' } }),
      }),
    );
  });

  it('an AI message is written toward the campaign goal, from research asked with its context', async () => {
    const id = launch(
      config({
        steps: [
          {
            type: 'send_message',
            channel: 'test',
            executionMode: 'auto',
            delaySeconds: 0,
            mode: 'ai',
            subject: '',
            body: '',
            instructions: 'Ask for a short call.',
          },
        ],
      }),
      [person(acme())],
    );
    h.anthropic.answer(synthesis('match'), {
      input: {
        subject: 'Your Berlin office',
        body: 'Hello Bob, congratulations on Berlin.',
        usedFacts: ['F1'],
      },
    });
    await settle();
    expect(runs()[0]).toMatchObject({ campaign_id: id, goal: GOAL });
    const draftPrompt = h.anthropic.requests[1]?.user ?? '';
    expect(draftPrompt).toContain(`Campaign goal (what the sender wants to achieve):\n${GOAL}`);
    expect(h.services.approvals.pending()[0]?.subject).toBe('Your Berlin office');
  });

  it('shows a fact’s captured source with the quote placed in it, and survives retention (FR-RES-005)', async () => {
    const companyId = acme();
    h.anthropic.answer(synthesis('match'));
    const run = h.services.research.start({ companyId }, ctx());
    await h.run();
    const fact = h.services.research.get(run.id).facts.find((f) => f.verified)!;
    const source = h.services.research.factSource(fact.id);
    expect(source).toMatchObject({
      url: 'https://acme.test/',
      extractor: 'static-readability',
      omittedBefore: 0,
    });
    expect(source.text!.slice(source.highlight!.start, source.highlight!.end)).toBe(
      'In March 2026 we opened our new Berlin office',
    );
    h.db.prepare(`UPDATE evidence SET text = ''`).run();
    expect(h.services.research.factSource(fact.id)).toMatchObject({
      text: null,
      highlight: null,
      quote: fact.quote,
    });
  });

  it('a campaign’s AI budget counts its research and messages; when it is reached AI steps wait, nobody stops', async () => {
    const { models, provider, monthlyBudgetUsd } = h.services.ai.settings();
    // $1 per call of 1000 input tokens: the fake model's usage.
    h.services.ai.update(
      {
        provider,
        models,
        monthlyBudgetUsd,
        prices: {
          [models.research]: { inputPerMTok: 1000, outputPerMTok: 0 },
          [models.drafting]: { inputPerMTok: 1000, outputPerMTok: 0 },
        },
      },
      ctx(),
    );
    const aiStep = {
      type: 'send_message' as const,
      channel: 'test' as const,
      executionMode: 'auto' as const,
      delaySeconds: 0,
      mode: 'ai' as const,
      subject: '',
      body: '',
      instructions: 'Ask for a short call.',
    };
    const company = acme();
    h.anthropic.answer(synthesis('match'), {
      input: { subject: 'Berlin', body: 'Hello Bob.', usedFacts: ['F1'] },
    });
    const id = launch(config({ steps: [aiStep], aiBudgetUsd: 1 }), [
      person(company, 'Bob'),
      person(company, 'Ann'),
    ]);
    await settle();
    await settle();

    // The company's research ($1) used the budget; both messages wait for more, nobody is stopped.
    expect(h.services.campaigns.get(id).aiSpend).toEqual({ calls: 1, costUsd: 1 });
    expect(people(id).map((p) => [p.status, p.waiting])).toEqual([
      ['active', 'budget'],
      ['active', 'budget'],
    ]);
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ai_calls WHERE status = 'refused' AND error_class = 'campaign_budget'`,
        )
        .get(),
    ).toEqual({ n: 2 });
    // Calls for no campaign are not counted against it.
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM ai_calls WHERE campaign_id IS NULL`).get()).toEqual({
      n: 0,
    });
  });
});
