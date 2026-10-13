import {
  RpcError,
  campaignConfigSchema,
  templateFields,
  type CampaignConfig,
  type CampaignConfigInput,
  type CopilotIntent,
  type CopilotPlan,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AiGateway } from '../ai/gateway.js';
import { AiError } from '../ai/provider.js';
import type { PromptTemplate } from '../ai/prompts.js';

/**
 * Campaign copilot (ADR 033): a campaign drafted from the user's own words. The model only
 * proposes; `normalise` turns the proposal into a config under fixed rules the model cannot
 * change, and the editor's own checks say what a launch would still refuse. Nothing is saved here.
 */

const LANGUAGE_NAMES = { en: 'English', ru: 'Russian' } as const;
type Language = keyof typeof LANGUAGE_NAMES;

/** What TabReach can do, told to the model in both calls so it proposes nothing else. */
const CAPABILITIES = [
  'TabReach is a local Mac app for B2B outreach. The user imports their own prospect lists (CSV); TabReach never',
  'finds or buys lists. It researches each company on its own website (facts with verbatim quotes) and rates it',
  'against the ICP: match, possible_match, not_match, insufficient_data. A campaign is a sequence of steps:',
  "- message: email (from the user's mailbox), the company's website contact form, or LinkedIn (an invitation",
  '  with a short note, or a message). Text is a template with placeholders or written by AI per company from the',
  '  research facts, following instructions. LinkedIn is assisted: TabReach prepares, the user presses Send.',
  '- task: something the user does themselves (a call, a check); the sequence waits until they mark it done.',
  '- qualify: continue only for companies the research rates as a match (or also possible matches); otherwise',
  '  stop the person or skip the next step.',
  'Each step has a delay in days after the previous one (the first: after the person is added).',
  'Every message waits for the user\'s approval by default; "sample_then_auto" means the user approves the first',
  'five and the campaign sends the rest after the same checks. A reply stops the person in every campaign; the',
  'do-not-contact list is always applied. TabReach never solves CAPTCHAs or works around site protections.',
  `Template placeholders: ${templateFields.map((f) => `{{${f}}}`).join(', ')}; a default after "|", e.g.`,
  '{{firstName|there}}. No other placeholders exist.',
].join('\n');

const intentInput = z.object({ description: z.string(), language: z.enum(['en', 'ru']) });
const intentOutput = z.object({
  understanding: z.object({
    goal: z.string().max(500),
    audience: z.string().max(500),
    offer: z.string().max(500),
  }),
  questions: z
    .array(
      z.object({
        id: z.string().max(40),
        text: z.string().max(300),
        kind: z.enum(['single', 'multi', 'text']),
        options: z.array(z.string().max(120)).max(6),
      }),
    )
    .max(5),
  warnings: z.array(z.string().max(300)).max(5),
});

export const copilotIntent: PromptTemplate<z.infer<typeof intentInput>, z.infer<typeof intentOutput>> = {
  key: 'campaign.intent',
  version: 1,
  purpose: 'Understand what campaign the user describes and ask only the questions a plan cannot do without.',
  useCase: 'drafting',
  input: intentInput,
  output: intentOutput,
  maxTokens: 2_000,
  build: ({ description, language }) => ({
    system: [
      'You help a user set up an outreach campaign in TabReach.',
      CAPABILITIES,
      'Restate briefly what you understood: the goal, the audience (companies and the people to reach) and the offer.',
      'Then ask only the questions without which the campaign would be a guess — at most five, none if the description',
      'is enough. Typical gaps: which companies fit and which do not, who to write to, which channels may be used,',
      'how many follow-ups, observable signals for research. Prefer "single" or "multi" questions with 2–6 short',
      'suggested answers; use "text" only when no options make sense. Do not ask for anything TabReach cannot do.',
      'Warnings: say plainly when the user asks for something TabReach does not do (finding lists, automatic LinkedIn',
      'sending, guaranteed results) or when a criterion cannot be checked on a website.',
      `Write everything in ${LANGUAGE_NAMES[language]}. Plain text, no Markdown.`,
    ].join('\n'),
    user: `The user's description:\n${description}`,
  }),
};

const stepOut = z.object({
  kind: z.enum(['message', 'task', 'qualify']),
  delayDays: z.number().int().min(0).max(365),
  channel: z.enum(['email', 'web_form', 'linkedin']).nullable(),
  linkedinAction: z.enum(['connect', 'message']).nullable(),
  /** Who presses Send, as the user asked for it; the rules decide what is used. */
  sendMode: z.enum(['auto', 'assisted', 'manual']).nullable(),
  writing: z.enum(['template', 'ai']).nullable(),
  subject: z.string().max(300),
  body: z.string().max(5_000),
  instructions: z.string().max(2_000),
  title: z.string().max(200),
  accept: z.enum(['match', 'match_or_possible']).nullable(),
  onFail: z.enum(['stop', 'skip']).nullable(),
});

const planInput = z.object({
  description: z.string(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  language: z.enum(['en', 'ru']),
});
const planOutput = z.object({
  name: z.string().max(120),
  goal: z.string().max(1_000),
  icp: z.string().max(2_000),
  researchInstructions: z.string().max(2_000),
  researchContacts: z.boolean(),
  steps: z.array(stepOut).max(8),
  approval: z.enum(['each', 'sample_then_auto']),
  unsupported: z.array(z.object({ request: z.string().max(300), replacement: z.string().max(300) })).max(5),
  assumptions: z.array(z.string().max(300)).max(6),
  warnings: z.array(z.string().max(300)).max(6),
});
export type CopilotProposal = z.infer<typeof planOutput>;

export const copilotPlan: PromptTemplate<z.infer<typeof planInput>, CopilotProposal> = {
  key: 'campaign.plan',
  version: 1,
  purpose:
    'Propose a whole campaign — goal, ICP, research, steps and texts — from the description and answers.',
  useCase: 'drafting',
  input: planInput,
  output: planOutput,
  maxTokens: 6_000,
  build: ({ description, answers, language }) => ({
    system: [
      'You propose a complete outreach campaign for TabReach; the user reviews it before anything is saved.',
      CAPABILITIES,
      'Fill: a short name; the goal (what a reply should lead to); the ICP (who fits and who does not, with',
      'signals a company website can show); what research should look for; whether to research each person too',
      '(only when messages should mention the person); 2–6 steps; the approval mode.',
      'Steps: fill every field; use null or "" for fields that do not apply to the kind. A qualify step usually comes',
      'first when the ICP matters. Messages: short, specific, one clear ask, no false familiarity, no claims about',
      'the company that research has not found. For writing "ai", put the brief in instructions (tone, offer, call to',
      'action, length) and leave subject and body empty; for "template", write subject and body with placeholders.',
      'A LinkedIn invitation note is at most 200 characters. Tasks have a title and instructions.',
      'Approval: "each" unless the user clearly wants sending without approving every message.',
      'unsupported: everything the user asked for that TabReach does not do, each with what the plan does instead.',
      'assumptions: what you decided where the user left it open. warnings: risks the user should know.',
      `Write the name, goal, ICP, research instructions, assumptions, warnings and unsupported in ${LANGUAGE_NAMES[language]}.`,
      'Write message texts and AI instructions in the language the user wants to write to prospects in; if they did',
      `not say, in ${LANGUAGE_NAMES[language]}. Plain text, no Markdown.`,
    ].join('\n'),
    user: [
      `The user's description:\n${description}`,
      '',
      answers.length
        ? `Their answers:\n${answers.map((a) => `- ${a.question}\n  ${a.answer}`).join('\n')}`
        : 'No further answers.',
    ].join('\n'),
  }),
};

const DAY = 86_400;
/** The approval sample when the user asks for sending without approving each message (ADR 033). */
const SAMPLE_SIZE = 5;

export interface Normalised {
  config: CampaignConfig;
  changes: { requested: string; replacement: string }[];
}

/**
 * Applies the fixed rules (ADR 033) to a proposal. Whatever the model says: LinkedIn and form
 * steps are assisted, approval is each message or the default sample, delays stay in range, and a
 * qualification condition uses only equality. `rules` are the user-facing words for each change.
 */
export function normalise(
  p: CopilotProposal,
  emailAccountId: string | null,
  rules: { linkedinAuto: string; linkedinAssisted: string; formAuto: string; formAssisted: string },
): Normalised {
  const changes: Normalised['changes'] = [];
  const steps: CampaignConfigInput['steps'] = [];
  for (const s of p.steps.slice(0, 8)) {
    const delaySeconds = Math.min(Math.max(Math.round(s.delayDays), 0), 365) * DAY;
    if (s.kind === 'task') {
      steps.push({
        type: 'human_task',
        delaySeconds,
        title: s.title.trim(),
        instructions: s.instructions.trim(),
      });
      continue;
    }
    if (s.kind === 'qualify') {
      const conditions =
        s.accept === 'match_or_possible'
          ? [
              { field: 'research.qualification' as const, op: 'neq' as const, value: 'not_match' },
              { field: 'research.qualification' as const, op: 'neq' as const, value: 'insufficient_data' },
            ]
          : [{ field: 'research.qualification' as const, op: 'eq' as const, value: 'match' }];
      steps.push({
        type: 'condition',
        delaySeconds,
        conditions,
        onFalse: s.onFail === 'skip' ? 'skip' : 'stop',
      });
      continue;
    }
    const channel = s.channel ?? 'email';
    let executionMode: 'auto' | 'assisted' | 'manual' = 'auto';
    if (channel === 'linkedin') {
      executionMode = s.sendMode === 'manual' ? 'manual' : 'assisted';
      if (s.sendMode === 'auto')
        changes.push({ requested: rules.linkedinAuto, replacement: rules.linkedinAssisted });
    } else if (channel === 'web_form') {
      executionMode = 'assisted';
      if (s.sendMode === 'auto') changes.push({ requested: rules.formAuto, replacement: rules.formAssisted });
    }
    const ai = s.writing === 'ai';
    steps.push({
      type: 'send_message',
      channel,
      executionMode,
      delaySeconds,
      mode: ai ? 'ai' : 'template',
      subject: ai ? '' : s.subject.trim(),
      body: ai ? '' : s.body.trim(),
      instructions: s.instructions.trim(),
      linkedinAction: s.linkedinAction ?? 'message',
      replyAsThread: false,
    });
  }
  const usesEmail = steps.some((s) => s.type === 'send_message' && s.channel === 'email');
  const config = campaignConfigSchema.parse({
    steps,
    timezone: null,
    window: null,
    approvalMode: p.approval === 'sample_then_auto' ? 'approve_campaign' : 'approve_each',
    sampleSize: SAMPLE_SIZE,
    emailAccountId: usesEmail ? emailAccountId : null,
    goal: p.goal.trim(),
    icp: p.icp.trim(),
    researchInstructions: p.researchInstructions.trim(),
    researchContacts: p.researchContacts,
  });
  return { config, changes };
}

/** User-facing words for the fixed-rule changes, in the interface language. */
const RULE_WORDS: Record<Language, Parameters<typeof normalise>[2]> = {
  en: {
    linkedinAuto: 'Automatic LinkedIn sending',
    linkedinAssisted: 'LinkedIn steps are assisted: TabReach prepares the message, you press Send',
    formAuto: 'Website forms sent without you',
    formAssisted: 'Website forms are assisted: TabReach fills the form, you press Send',
  },
  ru: {
    linkedinAuto: 'Автоматическая отправка в LinkedIn',
    linkedinAssisted:
      'Шаги LinkedIn в режиме помощника: TabReach готовит сообщение, «Отправить» нажимаете вы',
    formAuto: 'Отправка форм на сайтах без вас',
    formAssisted: 'Формы на сайтах в режиме помощника: TabReach заполняет форму, «Отправить» нажимаете вы',
  },
};

export class CampaignCopilot {
  constructor(
    private readonly d: {
      ai: Pick<AiGateway, 'run'>;
      /** The editor's launch checks (CampaignService.problems). */
      problems: (config: CampaignConfig) => Record<string, string>;
      /** The first connected mailbox, for email steps. */
      emailAccount: () => string | null;
      /** Whether an AI key is stored: without one nothing is called (and no failed call is logged). */
      aiReady: () => boolean;
    },
  ) {}

  async intent(
    input: { description: string; language: Language },
    signal: AbortSignal,
    correlationId: string,
  ): Promise<CopilotIntent> {
    const out = await this.call(() => this.d.ai.run(copilotIntent, input, { correlationId, signal }));
    // Question ids are the model's; make them unique so answers cannot collide.
    const seen = new Set<string>();
    const questions = out.questions.map((q, i) => {
      const id = q.id.trim() && !seen.has(q.id) ? q.id : `q${i + 1}`;
      seen.add(id);
      return { ...q, id };
    });
    return { understanding: out.understanding, questions, warnings: out.warnings };
  }

  async plan(
    input: { description: string; answers: { question: string; answer: string }[]; language: Language },
    signal: AbortSignal,
    correlationId: string,
  ): Promise<CopilotPlan> {
    const proposal = await this.call(() => this.d.ai.run(copilotPlan, input, { correlationId, signal }));
    const { config, changes } = normalise(proposal, this.d.emailAccount(), RULE_WORDS[input.language]);
    return {
      name:
        proposal.name.trim().slice(0, 200) || (input.language === 'ru' ? 'Новая кампания' : 'New campaign'),
      config,
      changes: [
        ...proposal.unsupported.map((u) => ({ requested: u.request, replacement: u.replacement })),
        ...changes,
      ],
      assumptions: proposal.assumptions,
      warnings: proposal.warnings,
      problems: this.d.problems(config),
    };
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    if (!this.d.aiReady()) throw new RpcError('CONFLICT', 'No AI key', 'ai.no_key');
    try {
      return await run();
    } catch (error) {
      if (error instanceof AiError) throw new RpcError('CONFLICT', 'AI could not answer', `ai.${error.kind}`);
      throw error;
    }
  }
}
