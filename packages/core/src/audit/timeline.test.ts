import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

describe('timeline: what happened to a contact, a company, a campaign', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  async function sendOne() {
    const { prospects, campaigns, approvals } = h.services;
    const company = prospects.createCompany({ name: 'Acme', website: 'https://acme.test/' }, ctx()).id;
    const ann = prospects.createContact(
      { firstName: 'Ann', lastName: 'Lee', email: 'ann@acme.test', companyId: company },
      ctx(),
    ).id;
    const bob = prospects.createContact({ firstName: 'Bob', email: 'bob@other.test' }, ctx()).id;
    const campaign = campaigns.create(
      {
        name: 'Spring',
        config: {
          steps: [
            {
              type: 'send_message',
              channel: 'test',
              executionMode: 'auto',
              delaySeconds: 0,
              subject: 'Hi {{firstName}}',
              body: 'Hello {{firstName}}, a short note.',
            },
          ],
          timezone: 'UTC',
          window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
          emailAccountId: null,
        },
      },
      ctx(),
    ).id;
    campaigns.launch(campaign, ctx());
    campaigns.enroll(campaign, [ann], ctx());
    await h.run();
    const [approval] = approvals.pending();
    approvals.approve(approval!.id, approval!.contentHash, ctx());
    await h.run();
    return { company, ann, bob, campaign };
  }

  it("a contact's history has its campaign steps, linked, with the message that was sent", async () => {
    const { ann, campaign } = await sendOne();
    const { items } = h.services.timeline.list({ contactId: ann, limit: 50 });
    expect(items.map((e) => `${e.actionType}:${e.status}`).reverse()).toEqual([
      'contact.created:completed',
      'enrollment.created:completed',
      'approval.requested:completed',
      'approval.approved:completed',
      'message.send:planned',
      'message.send:completed',
      'enrollment.completed:completed',
    ]);
    const sent = items.find((e) => e.actionType === 'message.send' && e.status === 'completed');
    expect(sent).toMatchObject({
      contact: { id: ann, name: 'Ann Lee' },
      company: { name: 'Acme' },
      campaign: { id: campaign, name: 'Spring' },
      message: { subject: 'Hi Ann', body: 'Hello Ann, a short note.', direction: 'outbound' },
    });
    expect(items.filter((e) => e.message !== null)).toHaveLength(1);
  });

  it('a company collects its contacts; a campaign its own events; categories and paging narrow it', async () => {
    const { company, bob, campaign } = await sendOne();
    const companyEvents = h.services.timeline.list({ companyId: company, limit: 50 }).items;
    expect(companyEvents.map((e) => e.actionType)).toContain('company.created');
    expect(companyEvents.map((e) => e.actionType)).toContain('message.send');
    expect(companyEvents.some((e) => e.contact?.id === bob)).toBe(false);

    const campaignEvents = h.services.timeline.list({ campaignId: campaign, limit: 50 }).items;
    expect(campaignEvents.map((e) => e.actionType)).toEqual(
      expect.arrayContaining(['campaign.created', 'campaign.launched', 'enrollment.created', 'message.send']),
    );
    expect(campaignEvents.some((e) => e.actionType === 'contact.created')).toBe(false);

    const messages = h.services.timeline.list({ category: 'messages', limit: 50 }).items;
    expect(new Set(messages.map((e) => e.actionType.split('.')[0]))).toEqual(
      new Set(['approval', 'message']),
    );

    const first = h.services.timeline.list({ limit: 3 });
    expect(first).toMatchObject({ hasMore: true });
    const last = first.items.at(-1)!;
    const next = h.services.timeline.list({ limit: 500, before: { createdAt: last.createdAt, id: last.id } });
    expect(next.hasMore).toBe(false);
    const all = h.services.timeline.list({ limit: 500 }).items;
    expect([...first.items, ...next.items].map((e) => e.id)).toEqual(all.map((e) => e.id));
  });
});
