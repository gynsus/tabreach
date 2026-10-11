import type { CampaignConfigInput } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

const DAY = 24 * 60 * 60_000;

/** human_task: a step the person does and marks done (docs/17). */
describe('task steps', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  const config = (over: Partial<CampaignConfigInput> = {}): CampaignConfigInput => ({
    steps: [
      {
        type: 'human_task',
        delaySeconds: 0,
        title: 'Call {{firstName}} at {{companyName|their company}}',
        instructions: 'Ask about {{companyName|the company}}.',
      },
      {
        type: 'send_message',
        channel: 'test',
        executionMode: 'auto',
        delaySeconds: 2 * 86_400,
        subject: 'Hi',
        body: 'Hello',
      },
    ],
    timezone: 'UTC',
    window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
    ...over,
  });
  let people = 0;
  function start(c: CampaignConfigInput = config()): { campaign: string; contact: string } {
    const { campaigns, prospects } = h.services;
    const campaign = campaigns.create({ name: 'Tasks', config: c }, ctx()).id;
    campaigns.launch(campaign, ctx());
    const contact = prospects.createContact(
      { firstName: 'Bob', email: `bob${++people}@beta.test` },
      ctx(),
    ).id;
    campaigns.enroll(campaign, [contact], ctx());
    return { campaign, contact };
  }
  const tasks = (status: 'open' | 'all' = 'open') =>
    h.services.campaigns.listTasks(status, { limit: 50, offset: 0 });
  const person = (campaign: string) =>
    h.services.campaigns.listEnrollments(campaign, { limit: 1, offset: 0 }).items[0];

  it('a task waits in Tasks with the person’s details filled in; Done moves the sequence on', async () => {
    const { campaign } = start();
    await h.run();
    const [task] = tasks().items;
    expect(task).toMatchObject({
      title: 'Call Bob at their company',
      instructions: 'Ask about the company.',
      status: 'open',
      contactName: 'Bob',
      campaignName: 'Tasks',
      stepPosition: 1,
    });
    expect(person(campaign)).toMatchObject({ status: 'active', stepPosition: 1, waiting: 'task' });
    // Nothing happens on its own.
    h.clock.advance(5 * DAY);
    await h.run();
    expect(h.services.approvals.pending()).toHaveLength(0);

    h.services.campaigns.resolveTask(task!.id, 'done', ctx());
    expect(person(campaign)).toMatchObject({ stepPosition: 2, waiting: 'schedule' });
    expect(tasks('all').items[0]).toMatchObject({ status: 'done' });
    h.clock.advance(2 * DAY + 60_000);
    await h.run();
    expect(h.services.approvals.pending()).toHaveLength(1);
    expect(() => h.services.campaigns.resolveTask(task!.id, 'done', ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'task.notOpen' }) }),
    );
  });

  it('Skip goes on too; Stop takes the person out', async () => {
    const a = start();
    await h.run();
    h.services.campaigns.resolveTask(tasks().items[0]!.id, 'skip', ctx());
    expect(person(a.campaign)).toMatchObject({ stepPosition: 2 });
    expect(tasks('all').items[0]).toMatchObject({ status: 'skipped' });

    const b = start(config({ goal: 'second' }));
    await h.run();
    h.services.campaigns.resolveTask(tasks().items[0]!.id, 'stop', ctx());
    expect(person(b.campaign)).toMatchObject({ status: 'stopped', stopReason: 'manual' });
  });

  it('an open task goes when the person leaves the campaign or moves to another version', async () => {
    const { campaign } = start();
    await h.run();
    const enrollment = person(campaign)!;
    h.services.campaigns.stopEnrollment(enrollment.id, ctx());
    expect(tasks().items).toHaveLength(0);
    expect(tasks('all').items[0]).toMatchObject({ status: 'cancelled' });

    const second = start(config({ goal: 'again' }));
    await h.run();
    expect(tasks().items).toHaveLength(1);
    const c = h.services.campaigns.get(second.campaign);
    h.services.campaigns.update(
      {
        id: second.campaign,
        config: {
          ...c.config,
          steps: [{ type: 'human_task', delaySeconds: 0, title: 'Send a postcard', instructions: '' }],
        },
      },
      ctx(),
    );
    h.services.campaigns.launch(second.campaign, ctx());
    expect(h.services.campaigns.migrate(second.campaign, ctx())).toMatchObject({ moved: 1 });
    await h.run();
    expect(tasks().items.map((t) => t.title)).toEqual(['Send a postcard']);
  });

  it('a task needs a title to launch; the dry run stops at it', async () => {
    const { campaigns, prospects } = h.services;
    const noTitle = campaigns.create(
      {
        name: 'No title',
        config: config({ steps: [{ type: 'human_task', delaySeconds: 0, title: ' ', instructions: '' }] }),
      },
      ctx(),
    ).id;
    expect(() => campaigns.launch(noTitle, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.title': 'task.titleRequired' } }),
      }),
    );
    const preview = campaigns.create({ name: 'Preview', config: config() }, ctx()).id;
    const contact = prospects.createContact({ firstName: 'Ann', email: 'ann@beta.test' }, ctx()).id;
    const result = await campaigns.preview(
      { campaignId: preview, contactId: contact, generate: false },
      AbortSignal.timeout(5_000),
      'c',
    );
    expect(result.outcome).toMatchObject({ kind: 'task', position: 1, title: 'Call Ann at their company' });
  });
});
