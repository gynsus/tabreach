import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CampaignStep, CopilotIntent, CopilotPlan, CopilotQuestion } from '@tabreach/protocol';
import type { TFunction } from 'i18next';
import { ClipboardCheck, Mail, Sparkles, Split } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Field, Input, PageHeader } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

type Language = 'en' | 'ru';
type Answer = { picked: string[]; text: string };

const textarea =
  'min-h-32 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none';

/**
 * Campaign copilot (ADR 033): the user's own words → a few questions → a plan checked like the
 * editor's → a draft. Nothing is saved before "Create draft", and the draft is never launched here.
 */
export function CopilotPage() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === 'ru' ? 'ru' : 'en';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [description, setDescription] = useState('');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [name, setName] = useState('');

  const intent = useMutation({
    mutationFn: () => call('copilot.intent', { description, language }),
    onSuccess: () => setAnswers({}),
  });
  const plan = useMutation({
    mutationFn: (questions: CopilotQuestion[]) =>
      call('copilot.plan', {
        description,
        language,
        answers: questions
          .map((q) => ({ question: q.text, answer: answerText(answers[q.id]) }))
          .filter((a) => a.answer !== ''),
      }),
    onSuccess: (p) => setName(p.name),
  });
  const create = useMutation({
    mutationFn: (p: CopilotPlan) =>
      call('campaigns.create', { name: name.trim() || p.name, config: p.config }),
    onSuccess: async (c) => {
      await invalidateEntities(qc, ['campaign']);
      await navigate(`/campaigns/${c.id}`);
    },
  });

  const stage = plan.data ? 'plan' : intent.data ? 'questions' : 'describe';
  const restart = () => {
    intent.reset();
    plan.reset();
  };

  return (
    <>
      <PageHeader
        title={t('copilot.title')}
        subtitle={
          <span className="flex items-center gap-2">
            <Link to="/campaigns" className="hover:text-ink">
              {t('campaigns.title')}
            </Link>
            <span>{t('copilot.subtitle')}</span>
          </span>
        }
        actions={
          stage !== 'describe' ? (
            <Button variant="ghost" onClick={restart}>
              {t('copilot.startOver')}
            </Button>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto p-6">
        <ol className="flex gap-4 font-mono text-[11px] text-faint" aria-label={t('copilot.stagesLabel')}>
          {(['describe', 'questions', 'plan'] as const).map((s, i) => (
            <li
              key={s}
              aria-current={stage === s ? 'step' : undefined}
              className={stage === s ? 'text-accent' : ''}
            >
              {i + 1}. {t(`copilot.stages.${s}`)}
            </li>
          ))}
        </ol>

        {stage === 'describe' ? (
          <section className="grid gap-3">
            <Field label={t('copilot.describe')} hint={t('copilot.describeHint')}>
              {(id, describedBy) => (
                <textarea
                  id={id}
                  className={textarea}
                  maxLength={4_000}
                  value={description}
                  placeholder={t('copilot.describePlaceholder')}
                  aria-describedby={describedBy}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
            {intent.isError ? <Alert>{errorMessage(t, intent.error)}</Alert> : null}
            <div>
              <Button
                variant="primary"
                onClick={() => intent.mutate()}
                disabled={intent.isPending || description.trim().length < 10}
              >
                <Sparkles size={14} aria-hidden />
                {intent.isPending ? t('copilot.thinking') : t('copilot.continue')}
              </Button>
            </div>
          </section>
        ) : null}

        {stage === 'questions' && intent.data ? (
          <Questions
            intent={intent.data}
            answers={answers}
            onAnswer={(id, a) => setAnswers((prev) => ({ ...prev, [id]: a }))}
            busy={plan.isPending}
            error={plan.isError ? errorMessage(t, plan.error) : null}
            onBuild={() => plan.mutate(intent.data.questions)}
          />
        ) : null}

        {stage === 'plan' && plan.data ? (
          <Plan
            plan={plan.data}
            name={name}
            onName={setName}
            busy={create.isPending}
            error={create.isError ? errorMessage(t, create.error) : null}
            onBack={() => plan.reset()}
            onCreate={() => create.mutate(plan.data)}
          />
        ) : null}
      </div>
    </>
  );
}

function answerText(a: Answer | undefined): string {
  if (!a) return '';
  return [...a.picked, a.text.trim()].filter(Boolean).join('; ');
}

function Questions(props: {
  intent: CopilotIntent;
  answers: Record<string, Answer>;
  onAnswer: (id: string, a: Answer) => void;
  busy: boolean;
  error: string | null;
  onBuild: () => void;
}) {
  const { t } = useTranslation();
  const u = props.intent.understanding;
  return (
    <section className="grid gap-5">
      <div className="grid gap-2 rounded-md border border-rule bg-raised p-4 text-[13px]">
        <h2 className="text-[15px] font-semibold">{t('copilot.understood')}</h2>
        <p>
          <span className="text-soft">{t('copilot.goal')}: </span>
          {u.goal}
        </p>
        <p>
          <span className="text-soft">{t('copilot.audience')}: </span>
          {u.audience}
        </p>
        <p>
          <span className="text-soft">{t('copilot.offer')}: </span>
          {u.offer}
        </p>
      </div>
      {props.intent.warnings.length ? (
        <Alert tone="warn">
          <ul className="grid gap-1">
            {props.intent.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {props.intent.questions.length === 0 ? (
        <p className="text-[13px] text-soft">{t('copilot.noQuestions')}</p>
      ) : null}
      {props.intent.questions.map((q) => {
        const a = props.answers[q.id] ?? { picked: [], text: '' };
        return (
          <fieldset key={q.id} className="grid gap-2" data-testid="copilot-question">
            <legend className="mb-1 text-[13px] font-medium">{q.text}</legend>
            {q.kind !== 'text'
              ? q.options.map((o) => (
                  <label key={o} className="flex items-center gap-2 text-[13px]">
                    <input
                      type={q.kind === 'single' ? 'radio' : 'checkbox'}
                      name={q.id}
                      checked={a.picked.includes(o)}
                      onChange={(e) => {
                        const picked =
                          q.kind === 'single'
                            ? [o]
                            : e.target.checked
                              ? [...a.picked, o]
                              : a.picked.filter((p) => p !== o);
                        props.onAnswer(q.id, { ...a, picked });
                      }}
                    />
                    {o}
                  </label>
                ))
              : null}
            <Input
              aria-label={q.kind === 'text' ? q.text : t('copilot.other')}
              placeholder={q.kind === 'text' ? '' : t('copilot.other')}
              value={a.text}
              maxLength={1_000}
              onChange={(e) => props.onAnswer(q.id, { ...a, text: e.target.value })}
            />
          </fieldset>
        );
      })}
      {props.error ? <Alert>{props.error}</Alert> : null}
      <div>
        <Button variant="primary" onClick={props.onBuild} disabled={props.busy}>
          <Sparkles size={14} aria-hidden />
          {props.busy ? t('copilot.building') : t('copilot.build')}
        </Button>
      </div>
    </section>
  );
}

function Plan(props: {
  plan: CopilotPlan;
  name: string;
  onName: (name: string) => void;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const { plan } = props;
  const c = plan.config;
  const problems = Object.entries(plan.problems);
  let elapsed = 0;
  return (
    <section className="grid gap-6" data-testid="copilot-plan">
      <Field label={t('copilot.name')} className="max-w-md">
        {(id) => (
          <Input id={id} value={props.name} maxLength={200} onChange={(e) => props.onName(e.target.value)} />
        )}
      </Field>

      <PlanBlock title={t('copilot.goal')} text={c.goal} />
      <PlanBlock title={t('campaigns.targeting.icp')} text={c.icp} />
      <PlanBlock title={t('campaigns.targeting.researchInstructions')} text={c.researchInstructions} />
      {c.researchContacts ? <p className="text-[13px]">{t('copilot.researchPeople')}</p> : null}

      <div className="grid gap-2">
        <h2 className="text-[15px] font-semibold">{t('campaigns.sequence')}</h2>
        <ol className="grid gap-2">
          {c.steps.map((s, i) => {
            elapsed += s.delaySeconds;
            return (
              <li key={i} className="grid grid-cols-[4.5rem_1fr] gap-3" data-testid="copilot-step">
                <span className="pt-3 text-right font-mono text-[11px] text-soft">
                  {t('campaigns.day', { n: Math.floor(elapsed / 86_400) + 1 })}
                </span>
                <StepSummary step={s} />
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid gap-2 text-[13px]">
        <h2 className="text-[15px] font-semibold">{t('copilot.safety')}</h2>
        <ul className="grid list-disc gap-1 pl-5">
          <li>
            {c.approvalMode === 'approve_each'
              ? t('campaigns.approvalModes.approve_each')
              : t('copilot.sample', { count: c.sampleSize })}
          </li>
          <li>{t('copilot.alwaysRules')}</li>
        </ul>
      </div>

      {plan.changes.length ? (
        <div className="grid gap-2 text-[13px]" data-testid="copilot-changes">
          <h2 className="text-[15px] font-semibold">{t('copilot.changes')}</h2>
          <ul className="grid gap-2">
            {plan.changes.map((ch, i) => (
              <li key={i} className="grid gap-0.5 rounded-md border border-rule bg-raised px-3 py-2">
                <span className="text-soft line-through">{ch.requested}</span>
                <span>→ {ch.replacement}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <NoteList title={t('copilot.assumptions')} items={plan.assumptions} />
      <NoteList title={t('copilot.warnings')} items={plan.warnings} tone="warn" />
      {problems.length ? (
        <Alert tone="warn">
          <p className="mb-1 font-medium">{t('copilot.problems')}</p>
          <ul className="grid gap-1" data-testid="copilot-problems">
            {problems.map(([field, key]) => (
              <li key={field}>{problemText(t, field, key)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {props.error ? <Alert>{props.error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={props.onCreate} disabled={props.busy}>
          {t('copilot.create')}
        </Button>
        <Button variant="ghost" onClick={props.onBack} disabled={props.busy}>
          {t('copilot.back')}
        </Button>
        <span className="text-xs text-soft">{t('copilot.createHint')}</span>
      </div>
    </section>
  );
}

function problemText(t: TFunction, field: string, key: string): string {
  const text = translateKey(t, `errors.${key}`, t('errors.generic'));
  const step = /^steps\.(\d+)/.exec(field);
  return step ? `${t('copilot.stepN', { n: Number(step[1]) + 1 })}: ${text}` : text;
}

function PlanBlock(props: { title: string; text: string }) {
  if (!props.text.trim()) return null;
  return (
    <div className="grid gap-1 text-[13px]">
      <h2 className="text-[15px] font-semibold">{props.title}</h2>
      <p className="whitespace-pre-wrap">{props.text}</p>
    </div>
  );
}

function NoteList(props: { title: string; items: string[]; tone?: 'warn' }) {
  if (!props.items.length) return null;
  return (
    <div className="grid gap-1 text-[13px]">
      <h2 className="text-[15px] font-semibold">{props.title}</h2>
      <ul
        className={
          props.tone === 'warn' ? 'grid list-disc gap-1 pl-5 text-warn' : 'grid list-disc gap-1 pl-5'
        }
      >
        {props.items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

function StepSummary({ step: s }: { step: CampaignStep }) {
  const { t } = useTranslation();
  const box = 'grid gap-1 rounded-md border border-rule bg-raised px-4 py-3 text-[13px]';
  if (s.type === 'human_task') {
    return (
      <div className={box}>
        <p className="flex items-center gap-2 font-medium">
          <ClipboardCheck size={14} aria-hidden />
          {t('copilot.task')}: {s.title}
        </p>
        {s.instructions ? <p className="whitespace-pre-wrap text-soft">{s.instructions}</p> : null}
      </div>
    );
  }
  if (s.type === 'condition') {
    const possible = s.conditions.some((c) => c.op === 'neq');
    return (
      <div className={box}>
        <p className="flex items-center gap-2 font-medium">
          <Split size={14} aria-hidden />
          {possible ? t('copilot.qualifyPossible') : t('copilot.qualifyMatch')}
        </p>
        <p className="text-soft">
          {s.onFalse === 'stop' ? t('copilot.otherwiseStop') : t('copilot.otherwiseSkip')}
        </p>
      </div>
    );
  }
  return (
    <div className={box}>
      <p className="flex flex-wrap items-center gap-2 font-medium">
        <Mail size={14} aria-hidden />
        {t(`campaigns.channels.${s.channel}`)}
        {s.channel === 'linkedin' ? ` · ${t(`campaigns.linkedinActions.${s.linkedinAction}`)}` : ''}
        <Badge tone={s.mode === 'ai' ? 'accent' : 'neutral'}>{t(`campaigns.modes.${s.mode}.name`)}</Badge>
        {s.channel !== 'email' ? <Badge>{t(`campaigns.executionModes.${s.executionMode}`)}</Badge> : null}
      </p>
      {s.mode === 'ai' ? (
        <p className="whitespace-pre-wrap text-soft">{s.instructions}</p>
      ) : (
        <>
          {s.subject ? <p className="font-medium">{s.subject}</p> : null}
          <p className="whitespace-pre-wrap text-soft">{s.body}</p>
        </>
      )}
    </div>
  );
}
