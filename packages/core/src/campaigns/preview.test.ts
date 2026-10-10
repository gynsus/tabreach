import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import type { CampaignConfigInput, CampaignStep } from '@tabreach/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

const DAY = 24 * 60 * 60_000;
const signal = () => AbortSignal.timeout(10_000);

const message = (over: Partial<Extract<CampaignStep, { type: 'send_message' }>> = {}): CampaignStep => ({
  type: 'send_message',
  channel: 'test',
  executionMode: 'auto',
  delaySeconds: 0,
  mode: 'template',
  linkedinAction: 'message',
  subject: 'Hello {{firstName}}',
  body: 'Hi {{firstName}}, a note for {{companyName|your team}}.',
  instructions: '',
  signature: '',
  ...over,
});

/** What a dry run must never leave behind. */
const TRACES = [
  'campaign_enrollments',
  'workflow_runs',
  'message_drafts',
  'approvals',
  'side_effects',
  'test_channel_deliveries',
  'form_preparations',
];

/** Campaign clone, delete and dry-run preview (FR-CAM-001, FR-CAM-008, docs/17). */
describe('campaign clone, delete and dry run', () => {
  let fixtures: FixtureServer;
  let h: Harness;
  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });
  afterAll(() => fixtures.close());
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  const draft = (steps: CampaignStep[], over: Partial<CampaignConfigInput> = {}) =>
    h.services.campaigns.create(
      {
        name: 'Spring',
        config: {
          steps,
          timezone: 'UTC',
          // Monday to Friday, 09:00–18:00 in the recipient's zone. The clock starts Monday 10:00 UTC.
          window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
          emailAccountId: null,
          ...over,
        },
      },
      ctx(),
    ).id;
  const contact = (first: string, email: string | null, company?: { name: string; website?: string }) => {
    const companyId = company ? h.services.prospects.createCompany(company, ctx()).id : null;
    return h.services.prospects.createContact({ firstName: first, email, companyId }, ctx()).id;
  };
  const preview = (campaignId: string, contactId: string, generate = false) =>
    h.services.campaigns.preview({ campaignId, contactId, generate }, signal(), 'corr');
  const counts = () =>
    Object.fromEntries(
      TRACES.map((t) => [t, (h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
    );

  it('shows the first action — after the conditions, at the first allowed time — and stores nothing', async () => {
    const ann = contact('Ann', 'ann@acme.test', { name: 'Acme' });
    const campaign = draft([
      {
        type: 'condition',
        delaySeconds: 0,
        conditions: [{ field: 'company.name', op: 'exists' }],
        onFalse: 'stop',
      },
      message({ delaySeconds: 9 * 60 * 60 }), // 19:00 Monday: outside the window
    ]);
    const before = counts();
    const audit = h.db.prepare('SELECT COUNT(*) AS n FROM action_events').get();

    expect(await preview(campaign, ann)).toEqual({
      contactName: 'Ann',
      alreadyEnrolled: false,
      conditions: [{ position: 1, holds: true, onFalse: 'stop' }],
      outcome: {
        kind: 'action',
        position: 2,
        channel: 'test',
        linkedinAction: null,
        executionMode: 'auto',
        target: 'ann@acme.test',
        plannedAt: '2026-09-29T09:00:00.000Z',
        timeZone: 'UTC',
        window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
        heldByWindow: true,
        deferredBy: null,
        content: { kind: 'template', subject: 'Hello Ann', body: 'Hi Ann, a note for Acme.' },
      },
    });
    expect(counts()).toEqual(before);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM action_events').get()).toEqual(audit);
  });

  it('a person held by the sending hours says so, with the hours and zone; a delay is just scheduled', () => {
    const ann = contact('Ann', 'ann@acme.test');
    const bob = contact('Bob', 'bob@beta.test');
    const late = draft([message({ delaySeconds: 9 * 60 * 60 })]); // 19:00 Monday → Tuesday 09:00
    const soon = draft([message({ delaySeconds: 60 * 60 })]); // 11:00 Monday, inside the hours
    for (const [campaign, person] of [
      [late, ann],
      [soon, bob],
    ] as const) {
      h.services.campaigns.launch(campaign, ctx());
      h.services.campaigns.enroll(campaign, [person], ctx());
    }
    expect(h.services.campaigns.listEnrollments(late, { limit: 1, offset: 0 }).items[0]).toMatchObject({
      nextActionAt: '2026-09-29T09:00:00.000Z',
      waiting: 'window',
      sendingHours: { timeZone: 'UTC', window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } },
    });
    expect(h.services.campaigns.listEnrollments(soon, { limit: 1, offset: 0 }).items[0]).toMatchObject({
      waiting: 'schedule',
      sendingHours: null,
    });
  });

  it('says why a contact would be stopped before anything goes out', async () => {
    const ann = contact('Ann', 'ann@acme.test', { name: 'Acme' });
    const bob = contact('Bob', 'bob@beta.test');
    const nobody = contact('Eve', null);

    const guarded = draft([
      {
        type: 'condition',
        delaySeconds: 0,
        conditions: [{ field: 'company.name', op: 'exists' }],
        onFalse: 'stop',
      },
      message(),
    ]);
    expect((await preview(guarded, bob)).outcome).toMatchObject({
      kind: 'stopped',
      position: 1,
      reason: 'condition_not_met',
    });

    const skipping = draft([
      {
        type: 'condition',
        delaySeconds: 0,
        conditions: [{ field: 'company.name', op: 'exists' }],
        onFalse: 'skip',
      },
      message(),
      message({ subject: 'Second {{firstName}}' }),
    ]);
    const skipped = await preview(skipping, bob);
    expect(skipped.conditions).toEqual([{ position: 1, holds: false, onFalse: 'skip' }]);
    expect(skipped.outcome).toMatchObject({ kind: 'action', position: 3 });

    const needsTitle = draft([message({ body: 'As {{jobTitle}} you know…' })]);
    expect((await preview(needsTitle, ann)).outcome).toMatchObject({
      kind: 'stopped',
      reason: 'missing_data',
      fields: ['jobTitle'],
    });

    const plain = draft([message()]);
    expect((await preview(plain, nobody)).outcome).toMatchObject({
      kind: 'stopped',
      reason: 'invalid_target',
      rule: 'target.test',
    });
    h.services.suppressions.add('domain', 'acme.test', ctx());
    expect((await preview(plain, ann)).outcome).toMatchObject({
      kind: 'stopped',
      reason: 'suppressed',
      rule: 'suppression.domain',
    });
  });

  it('runs the launch checks first, and refuses an unknown contact', async () => {
    const ann = contact('Ann', 'ann@acme.test');
    await expect(preview(draft([]), ann)).rejects.toMatchObject({
      problem: { code: 'VALIDATION_FAILED', fields: { steps: 'steps.required' } },
    });
    await expect(preview(draft([message()]), '00000000-0000-7000-8000-000000000000')).rejects.toMatchObject({
      problem: { code: 'NOT_FOUND' },
    });
  });

  it('a frequency cap moves the planned time; an enrolled contact is marked', async () => {
    const { campaign } = await h.campaignTo('bob@beta.test');
    h.approve();
    await h.run();
    expect(h.ledger()).toMatchObject([{ status: 'completed' }]);
    const bob = h.services.campaigns.listEnrollments(campaign, { limit: 1, offset: 0 }).items[0]!.contactId;

    const next = draft([message()], {
      window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
    });
    const result = await preview(next, bob);
    // The default contact cap is one touch in three days.
    expect(result.outcome).toMatchObject({ kind: 'action', deferredBy: 'cap.contact', heldByWindow: false });
    expect(
      new Date((result.outcome as { plannedAt: string }).plannedAt).getTime() - h.clock.now().getTime(),
    ).toBeGreaterThanOrEqual(3 * DAY - 60_000);
    expect(
      (
        await h.services.campaigns.preview(
          { campaignId: campaign, contactId: bob, generate: false },
          signal(),
          'c',
        )
      ).alreadyEnrolled,
    ).toBe(true);
  });

  it('an AI step is written only when asked: research first, then the message from verified facts, nothing stored', async () => {
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
    const ann = contact('Ann', 'ann@acme.test', { name: 'Acme Robotics', website: 'https://acme.test/' });
    const campaign = draft(
      [
        message({
          mode: 'ai',
          subject: '',
          body: '',
          instructions: 'Offer a short call next week. Write in English.',
          signature: 'Best,\n{{firstName|Bob}}',
        }),
      ],
      { window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } },
    );

    expect((await preview(campaign, ann)).outcome).toMatchObject({ content: { kind: 'ai_not_generated' } });
    expect(h.anthropic.requests).toHaveLength(0);

    // The company has no research yet: it starts, and the dry run says to ask again.
    expect((await preview(campaign, ann, true)).outcome).toMatchObject({
      content: { kind: 'ai_research_running' },
    });
    h.anthropic.answer({
      input: {
        companySummary: 'Acme Robotics builds picking robots.',
        facts: [
          {
            claim: 'Opened a Berlin office in March 2026.',
            evidenceRef: 'E1',
            quote: 'In March 2026 we opened our new Berlin office',
          },
        ],
        inferences: [],
        qualification: 'insufficient_data',
        qualificationReason: 'No criteria.',
        reasonToContact: 'New Berlin office.',
        missingInformation: [],
      },
    });
    for (let i = 0; i < 4; i++) {
      await h.run();
      h.clock.advance(61_000);
    }
    const before = counts();
    h.anthropic.answer({
      input: {
        subject: 'Your Berlin office (F1)',
        body: 'Hello Ann,\n\nCongrats on Berlin (F1).',
        usedFacts: ['F1'],
      },
    });
    expect((await preview(campaign, ann, true)).outcome).toMatchObject({
      kind: 'action',
      content: {
        kind: 'ai',
        subject: 'Your Berlin office',
        body: 'Hello Ann,\n\nCongrats on Berlin.\n\nBest,\nAnn',
        facts: [
          {
            claim: 'Opened a Berlin office in March 2026.',
            quote: 'In March 2026 we opened our new Berlin office',
            url: 'https://acme.test/',
          },
        ],
      },
    });
    expect(counts()).toEqual(before);
  });

  it('a clone is a new draft with the same settings and steps, without versions or people', async () => {
    const ann = contact('Ann', 'ann@acme.test');
    const source = draft([message(), message({ delaySeconds: DAY / 1000 })], { sampleSize: 7 });
    h.services.campaigns.launch(source, ctx());
    h.services.campaigns.enroll(source, [ann], ctx());

    const copy = h.services.campaigns.clone({ id: source, name: 'Spring (copy)' }, ctx());
    expect(copy).toMatchObject({
      name: 'Spring (copy)',
      status: 'draft',
      activeVersion: null,
      enrollments: { active: 0 },
      config: h.services.campaigns.get(source).config,
    });
    expect(copy.id).not.toBe(source);
    expect(
      h.db
        .prepare(
          `SELECT object_id, payload_redacted FROM action_events WHERE action_type = 'campaign.cloned'`,
        )
        .get(),
    ).toEqual({ object_id: copy.id, payload_redacted: JSON.stringify({ from: source }) });
    expect(() =>
      h.services.campaigns.clone({ id: '00000000-0000-7000-8000-000000000000', name: 'x' }, ctx()),
    ).toThrow(expect.objectContaining({ problem: expect.objectContaining({ code: 'NOT_FOUND' }) }));
  });

  it('only a campaign that was never launched can be deleted; a launched one stays, archived or not', () => {
    const ann = contact('Ann', 'ann@acme.test');
    const fresh = draft([message()]);
    const archivedDraft = draft([message()]);
    h.services.campaigns.archive(archivedDraft, ctx());
    const launched = draft([message()]);
    h.services.campaigns.launch(launched, ctx());
    h.services.campaigns.enroll(launched, [ann], ctx());
    h.services.campaigns.archive(launched, ctx());

    h.services.campaigns.delete(fresh, ctx());
    h.services.campaigns.delete(archivedDraft, ctx());
    expect(h.services.campaigns.list(true).map((c) => c.id)).toEqual([launched]);
    expect(
      h.db
        .prepare(
          `SELECT object_id, payload_redacted FROM action_events WHERE action_type = 'campaign.deleted'`,
        )
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([
      { object_id: fresh, payload_redacted: JSON.stringify({ name: 'Spring' }) },
      { object_id: archivedDraft, payload_redacted: JSON.stringify({ name: 'Spring' }) },
    ]);

    expect(() => h.services.campaigns.delete(launched, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ code: 'CONFLICT', detail: 'campaign.launched' }),
      }),
    );
    expect(() => h.services.campaigns.delete(fresh, ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    );
    expect(h.services.campaigns.list(false)).toEqual([]);
  });
});
