import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness, imapInput } from '../email/harness.js';
import { normalise, type CopilotProposal } from './copilot.js';

const signal = () => AbortSignal.timeout(5_000);
const ACCOUNT = '01a12761-9c75-7000-8db7-89dea183285f';

const RULES = {
  linkedinAuto: 'auto LinkedIn',
  linkedinAssisted: 'assisted LinkedIn',
  formAuto: 'auto forms',
  formAssisted: 'assisted forms',
};

type StepOut = CopilotProposal['steps'][number];
const step = (s: Partial<StepOut>): StepOut => ({
  kind: 'message',
  delayDays: 0,
  channel: 'email',
  linkedinAction: null,
  sendMode: null,
  writing: 'template',
  subject: 'Hello {{firstName|there}}',
  body: 'Hi {{firstName|there}}, a note for {{companyName}}.',
  instructions: '',
  title: '',
  accept: null,
  onFail: null,
  ...s,
});

const proposal = (p: Partial<CopilotProposal> = {}): CopilotProposal => ({
  name: 'Shopify brands AU',
  goal: 'A call about a store redesign',
  icp: 'Australian consumer brands on Shopify; not agencies',
  researchInstructions: 'Platform, products, wholesale',
  researchContacts: false,
  steps: [
    step({
      kind: 'qualify',
      channel: null,
      writing: null,
      subject: '',
      body: '',
      accept: 'match',
      onFail: 'stop',
    }),
    step({}),
    step({
      kind: 'task',
      delayDays: 3,
      channel: null,
      writing: null,
      subject: '',
      body: '',
      title: 'Call {{firstName}}',
    }),
  ],
  approval: 'each',
  unsupported: [],
  assumptions: ['Two follow-ups'],
  warnings: [],
  ...p,
});

describe('campaign copilot', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  it('needs an AI key, then asks only its questions, with unique ids, in the interface language', async () => {
    const input = {
      description: 'Find Australian Shopify brands with slow stores and offer a redesign.',
      language: 'ru' as const,
    };
    await expect(h.services.copilot.intent(input, signal(), 'c')).rejects.toMatchObject({
      problem: { detail: 'ai.no_key' },
    });
    // Refused before any call: nothing reaches the provider or the usage log.
    expect(h.anthropic.requests).toHaveLength(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get()).toEqual({ n: 0 });
    await h.services.ai.setKey('anthropic', 'sk-ant-test-0123456789abcdef', ctx());
    h.anthropic.answer({
      input: {
        understanding: { goal: 'Созвоны', audience: 'Бренды в Австралии', offer: 'Редизайн' },
        questions: [
          { id: 'who', text: 'Кому писать?', kind: 'single', options: ['Основателю', 'Маркетологу'] },
          { id: 'who', text: 'Какие каналы?', kind: 'multi', options: ['Почта', 'LinkedIn'] },
        ],
        warnings: ['TabReach не ищет списки компаний'],
      },
    });
    const intent = await h.services.copilot.intent(input, signal(), 'c');
    expect(intent.questions.map((q) => q.id)).toEqual(['who', 'q2']);
    const [request] = h.anthropic.requests;
    expect(request!.system).toContain('Write everything in Russian');
    expect(request!.system).toContain('never\nfinds or buys lists');
    expect(request!.user).toContain('slow stores');
  });

  it('turns a plan into a draft config that passes the editor checks and saves as a draft', async () => {
    await h.services.ai.setKey('anthropic', 'sk-ant-test-0123456789abcdef', ctx());
    const accountId = (await h.services.accounts.connectImap(imapInput(), ctx())).id;
    h.anthropic.answer({ input: proposal() });
    const plan = await h.services.copilot.plan(
      { description: 'Australian Shopify brands, offer a redesign.', answers: [], language: 'en' },
      signal(),
      'c',
    );
    expect(plan.name).toBe('Shopify brands AU');
    expect(plan.config.steps.map((s) => s.type)).toEqual(['condition', 'send_message', 'human_task']);
    expect(plan.config).toMatchObject({
      approvalMode: 'approve_each',
      emailAccountId: accountId,
      window: null,
    });
    expect(plan.config.steps[2]).toMatchObject({ delaySeconds: 3 * 86_400 });
    expect(plan.problems).toEqual({});
    expect(plan.assumptions).toEqual(['Two follow-ups']);

    // Saving is the ordinary create: a never-launched draft, nothing enrolled.
    const campaign = h.services.campaigns.create({ name: plan.name, config: plan.config }, ctx());
    expect(campaign).toMatchObject({ status: 'draft', activeVersion: null });
  });

  it('shows what a launch would refuse instead of hiding it', async () => {
    await h.services.ai.setKey('anthropic', 'sk-ant-test-0123456789abcdef', ctx());
    h.anthropic.answer({
      input: proposal({ steps: [step({ body: 'Hi {{nickname}}' })], icp: '' }),
    });
    const plan = await h.services.copilot.plan(
      { description: 'Write to my list about our product.', answers: [], language: 'en' },
      signal(),
      'c',
    );
    // No mailbox connected, and a placeholder that does not exist.
    expect(plan.problems).toMatchObject({
      emailAccountId: 'account.required',
      'steps.0.body': 'template.unknownField',
    });
  });
});

describe('copilot fixed rules (ADR 033)', () => {
  it('makes LinkedIn and form steps assisted and says so when auto was asked', () => {
    const { config, changes } = normalise(
      proposal({
        steps: [
          step({ channel: 'linkedin', linkedinAction: 'connect', sendMode: 'auto', subject: '', body: 'Hi' }),
          step({ channel: 'web_form', sendMode: 'auto' }),
          step({ channel: 'linkedin', sendMode: 'manual', subject: '', body: 'Hi' }),
        ],
      }),
      null,
      RULES,
    );
    expect(config.steps.map((s) => s.type === 'send_message' && s.executionMode)).toEqual([
      'assisted',
      'assisted',
      'manual',
    ]);
    expect(changes).toEqual([
      { requested: 'auto LinkedIn', replacement: 'assisted LinkedIn' },
      { requested: 'auto forms', replacement: 'assisted forms' },
    ]);
  });

  it('keeps hostile values in range: delays, step count, approval sample, qualification operators', () => {
    const { config } = normalise(
      proposal({
        steps: Array.from({ length: 12 }, (_, i) =>
          i === 0
            ? step({ kind: 'qualify', accept: 'match_or_possible', onFail: 'skip', delayDays: 10_000 })
            : step({ delayDays: -5 }),
        ),
        approval: 'sample_then_auto',
      }),
      ACCOUNT,
      RULES,
    );
    expect(config.steps).toHaveLength(8);
    expect(config.steps[0]).toMatchObject({
      type: 'condition',
      delaySeconds: 365 * 86_400,
      onFalse: 'skip',
      conditions: [
        { field: 'research.qualification', op: 'neq', value: 'not_match' },
        { field: 'research.qualification', op: 'neq', value: 'insufficient_data' },
      ],
    });
    expect(config.steps[1]).toMatchObject({ delaySeconds: 0 });
    // "Without approving each" is only ever the default sample, never sending unseen from the start.
    expect(config).toMatchObject({ approvalMode: 'approve_campaign', sampleSize: 5 });
  });

  it('an AI message keeps only its instructions; a mailbox is set only when email is used', () => {
    const { config } = normalise(
      proposal({
        steps: [
          step({ channel: 'web_form', writing: 'ai', subject: 'x', body: 'y', instructions: 'Be brief.' }),
        ],
      }),
      ACCOUNT,
      RULES,
    );
    expect(config.steps[0]).toMatchObject({ mode: 'ai', subject: '', body: '', instructions: 'Be brief.' });
    expect(config.emailAccountId).toBeNull();
  });
});
