import {
  type CampaignConfigInput,
  type FormPrepareResult,
  type RequestOf,
  type RequestType,
  type ResponseOf,
  type TaskResult,
} from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

/** What the worker does next with a form. */
type Prepare = 'ready' | 'challenge' | 'no_form';
type Submit = 'succeeded' | 'unknown' | 'changed' | 'challenge_appeared';

const fields = (message: string) => [
  {
    ref: 0,
    kind: 'text' as const,
    label: 'Your name',
    required: true,
    meaning: 'name' as const,
    source: 'pack' as const,
    value: 'Sam Sender',
  },
  {
    ref: 1,
    kind: 'email' as const,
    label: 'Email',
    required: true,
    meaning: 'email' as const,
    source: 'pack' as const,
    value: 'sam@sender.test',
  },
  {
    ref: 2,
    kind: 'textarea' as const,
    label: 'Message',
    required: true,
    meaning: 'message' as const,
    source: 'pack' as const,
    value: message,
  },
  {
    ref: 3,
    kind: 'checkbox' as const,
    label: 'Send me news',
    required: false,
    meaning: 'consent' as const,
    source: 'pack' as const,
    value: null,
  },
];

describe('website forms in campaigns (Phase 6b)', () => {
  let h: Harness;
  const prepares: Prepare[] = [];
  const submits: Submit[] = [];
  const calls: { type: string; payload: unknown }[] = [];
  const worker = {
    request<T extends RequestType>(type: T, payload: RequestOf<T>): Promise<ResponseOf<T>> {
      calls.push({ type, payload });
      if (type === 'profile.open')
        return Promise.resolve({ chromeVersion: '140', currentUrl: null } as ResponseOf<T>);
      if (type === 'form.prepare') {
        const req = payload as RequestOf<'form.prepare'>;
        const kind = prepares.shift() ?? 'ready';
        const result: FormPrepareResult =
          kind === 'no_form'
            ? {
                status: 'no_form',
                reason: 'form.notFound',
                formUrl: null,
                opener: null,
                signature: null,
                fields: [],
                challenge: null,
                screenshot: null,
                packVersion: '1.0.0',
              }
            : {
                status: kind === 'ready' ? 'ready' : 'needs_human',
                reason: kind === 'ready' ? null : 'form.challenge',
                formUrl: `${req.url}/contact`,
                opener: null,
                signature: 'sig-1',
                fields: fields(req.values.message ?? ''),
                challenge: kind === 'ready' ? null : 'generic.captcha.recaptcha',
                screenshot: Buffer.from('png').toString('base64'),
                packVersion: '1.0.0',
              };
        return Promise.resolve(result as ResponseOf<T>);
      }
      if (type === 'form.submit') {
        const req = payload as RequestOf<'form.submit'>;
        const kind = submits.shift() ?? 'succeeded';
        const base: TaskResult = {
          status: 'succeeded',
          stateId: null,
          stateKind: null,
          packVersion: '1.0.0',
          url: req.formUrl,
          diagnostics: null,
          errorKey: null,
          committed: false,
        };
        if (kind === 'changed')
          return Promise.resolve({
            ...base,
            status: 'unsupported_state',
            errorKey: 'form.changed',
          } as ResponseOf<T>);
        if (kind === 'challenge_appeared')
          return Promise.resolve({
            ...base,
            status: 'needs_human',
            errorKey: 'form.challenge',
          } as ResponseOf<T>);
        const { proceed } = h.services.checkpoints.reach({ taskId: req.taskId, phase: 'about_to_commit' });
        if (!proceed)
          return Promise.resolve({
            ...base,
            status: 'failed',
            errorKey: 'task.checkpointRefused',
          } as ResponseOf<T>);
        return Promise.resolve({ ...base, status: kind, committed: true } as ResponseOf<T>);
      }
      return Promise.resolve({ ok: true } as ResponseOf<T>);
    },
  };

  beforeEach(async () => {
    h = await new Harness().open();
    h.worker = worker;
    prepares.length = 0;
    submits.length = 0;
    calls.length = 0;
  });
  afterEach(() => h.close());

  const s = () => h.services;
  const sender = () => {
    const profile = s().browser.create({ name: 'Forms', purpose: 'general' }, ctx());
    s().forms.updateSender(
      {
        profileId: profile.id,
        name: 'Sam Sender',
        email: 'sam@sender.test',
        phone: '',
        company: 'Sender Co',
        website: '',
      },
      ctx(),
    );
    return profile.id;
  };
  const config = (over: Partial<CampaignConfigInput['steps'][number]> = {}): CampaignConfigInput => ({
    steps: [
      {
        type: 'send_message',
        channel: 'web_form',
        executionMode: 'auto',
        delaySeconds: 0,
        subject: 'Hello {{companyName}}',
        body: 'We build warehouse robots for {{companyName}}.',
        ...over,
      } as CampaignConfigInput['steps'][number],
    ],
    timezone: 'UTC',
    window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
    approvalMode: 'approve_each',
  });
  const start = async (website: string | null = 'acme.test') => {
    const campaign = s().campaigns.create({ name: 'Forms', config: config() }, ctx()).id;
    s().campaigns.launch(campaign, ctx());
    const companyId = s().prospects.createCompany(
      { name: 'Acme', ...(website ? { website } : {}) },
      ctx(),
    ).id;
    const contact = s().prospects.createContact({ firstName: 'Ann', companyId }, ctx()).id;
    s().campaigns.enroll(campaign, [contact], ctx());
    await h.run();
    return campaign;
  };
  const submitsSent = () =>
    calls.filter((c) => c.type === 'form.submit').map((c) => c.payload as RequestOf<'form.submit'>);

  it('prepares the form before approval, shows exactly what goes in, sends it once after approval', async () => {
    sender();
    const campaign = await start();
    const [approval] = s().approvals.pending();
    expect(approval).toMatchObject({ target: 'https://acme.test', channel: 'web_form' });
    expect(approval?.form).toMatchObject({
      formUrl: 'https://acme.test/contact',
      mode: 'auto',
      reason: null,
      hasScreenshot: true,
    });
    expect(approval?.form?.fields.find((f) => f.meaning === 'message')?.value).toBe(
      'We build warehouse robots for Acme.',
    );
    expect(approval?.form?.fields.find((f) => f.meaning === 'consent')?.value).toBeNull();
    expect(s().forms.screenshotOf(approval!.id)).toBe(Buffer.from('png').toString('base64'));
    expect(calls.find((c) => c.type === 'form.prepare')?.payload).toMatchObject({
      url: 'https://acme.test',
      values: {
        name: 'Sam Sender',
        firstName: 'Sam',
        lastName: 'Sender',
        email: 'sam@sender.test',
        company: 'Sender Co',
        subject: 'Hello Acme',
      },
    });
    expect(submitsSent()).toEqual([]);

    h.approve();
    await h.run();
    expect(submitsSent()).toHaveLength(1);
    expect(submitsSent()[0]).toMatchObject({
      formUrl: 'https://acme.test/contact',
      signature: 'sig-1',
      mode: 'auto',
      fields: [
        { ref: 0, value: 'Sam Sender' },
        { ref: 1, value: 'sam@sender.test' },
        { ref: 2, value: 'We build warehouse robots for Acme.' },
      ],
    });
    expect(h.ledger()).toMatchObject([{ status: 'completed' }]);
    expect(h.status(campaign)).toMatchObject({ status: 'completed' });
  });

  it('a CAPTCHA makes it assisted, never approved by policy; one appearing at send asks again', async () => {
    sender();
    prepares.push('challenge');
    await start();
    const [approval] = s().approvals.pending();
    expect(approval?.form).toMatchObject({ mode: 'assisted', reason: 'form.challenge' });
    h.approve();
    await h.run();
    expect(submitsSent()[0]).toMatchObject({ mode: 'assisted' });

    // Another company: prepared clean, a CAPTCHA appears when sending: nothing sent, asked again.
    submits.push('challenge_appeared');
    await start('beta.test');
    h.approve();
    h.clock.advance(3 * 60_000); // forms are paced: two minutes apart
    await h.run();
    const [again] = s().approvals.pending();
    expect(again?.form).toMatchObject({ mode: 'assisted' });
    expect(h.ledger()).toContainEqual(expect.objectContaining({ status: 'not_sent' }));
  });

  it('no form on the site stops the enrollment; a changed form is prepared and approved again', async () => {
    sender();
    prepares.push('no_form');
    const campaign = await start();
    expect(h.status(campaign)).toMatchObject({ status: 'stopped', stopReason: 'no_contact_form' });

    submits.push('changed');
    await start('beta.test');
    h.approve();
    await h.run();
    expect(calls.filter((c) => c.type === 'form.prepare')).toHaveLength(3);
    expect(s().approvals.pending()).toHaveLength(1);
  });

  it('waits, without using up attempts, while the person holds the sender’s window', async () => {
    const profile = sender();
    await s().browser.open(profile, null, ctx());
    await start();
    expect(calls.some((c) => c.type === 'form.prepare')).toBe(false);
    expect(s().approvals.pending()).toEqual([]);
    const job = h.db.prepare(`SELECT status, attempts FROM jobs WHERE type = 'workflow.run'`).get();
    expect(job).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('editing the message prepares the form again before a new approval', async () => {
    sender();
    await start();
    const [approval] = s().approvals.pending();
    expect(s().approvals.revise(approval!.draftId, 'Hello', 'A better message.', ctx())).toBeNull();
    await h.run();
    const [again] = s().approvals.pending();
    expect(again?.form?.fields.find((f) => f.meaning === 'message')?.value).toBe('A better message.');
  });

  it('launching needs a form sender; only forms may be assisted; a company without a website is skipped', async () => {
    const campaign = s().campaigns.create({ name: 'F', config: config() }, ctx()).id;
    expect(() => s().campaigns.launch(campaign, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.channel': 'forms.senderRequired' } }),
      }),
    );
    const email = s().campaigns.create(
      { name: 'E', config: config({ channel: 'test', executionMode: 'assisted' }) },
      ctx(),
    ).id;
    expect(() => s().campaigns.launch(email, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.executionMode': 'mode.autoOnly' } }),
      }),
    );
    sender();
    const noSite = await start(null);
    expect(h.status(noSite)).toMatchObject({ status: 'stopped', stopReason: 'invalid_target' });
  });
});
