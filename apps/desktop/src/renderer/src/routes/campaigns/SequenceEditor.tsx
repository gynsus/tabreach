import {
  conditionFieldSchema,
  conditionOpSchema,
  templateFields,
  type CampaignStep,
  type Condition,
} from '@tabreach/protocol';
import { ArrowDown, ArrowUp, Mail, Plus, Split, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Field, Input, Select } from '../../components/ui';
import { cn } from '../../lib/cn';

const DAY_SECONDS = 24 * 60 * 60;
const textarea =
  'min-h-32 w-full rounded-md border border-rule bg-raised px-2.5 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none aria-[invalid=true]:border-bad';

export const newMessage = (): CampaignStep => ({
  type: 'send_message',
  channel: 'test',
  executionMode: 'auto',
  delaySeconds: 0,
  subject: '',
  body: '',
});

export const newCondition = (): CampaignStep => ({
  type: 'condition',
  delaySeconds: 0,
  conditions: [{ field: 'contact.jobTitle', op: 'exists' }],
  onFalse: 'stop',
});

/** Steps of the campaign draft. Errors are launch-validation keys by path (`steps.0.body`). */
export function SequenceEditor(props: {
  steps: CampaignStep[];
  onChange: (steps: CampaignStep[]) => void;
  errors: Record<string, string>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { steps, onChange } = props;
  const update = (i: number, step: CampaignStep) => onChange(steps.map((s, j) => (j === i ? step : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [step] = next.splice(i, 1);
    if (step) next.splice(i + by, 0, step);
    onChange(next);
  };
  return (
    <div className="grid gap-3">
      {steps.length === 0 ? <p className="text-[13px] text-soft">{t('campaigns.noSteps')}</p> : null}
      {steps.map((step, i) => (
        <section
          key={i}
          aria-label={t(`campaigns.stepTitle.${step.type}`, { n: i + 1 })}
          className="grid gap-3 rounded-md border border-rule bg-raised p-4"
        >
          <header className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              {step.type === 'send_message' ? (
                <Mail size={14} aria-hidden />
              ) : (
                <Split size={14} aria-hidden />
              )}
              {t(`campaigns.stepTitle.${step.type}`, { n: i + 1 })}
            </h3>
            <span className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={props.disabled || i === 0}
                onClick={() => move(i, -1)}
                aria-label={t('campaigns.moveUp')}
              >
                <ArrowUp size={14} aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.disabled || i === steps.length - 1}
                onClick={() => move(i, 1)}
                aria-label={t('campaigns.moveDown')}
              >
                <ArrowDown size={14} aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={props.disabled}
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
                aria-label={t('campaigns.removeStep')}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </span>
          </header>
          <Field label={t('campaigns.delayDays')} hint={t('campaigns.delayHint')} className="max-w-xs">
            {(id, describedBy) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={365}
                step={1}
                aria-describedby={describedBy}
                disabled={props.disabled}
                value={Math.round(step.delaySeconds / DAY_SECONDS)}
                onChange={(e) =>
                  update(i, {
                    ...step,
                    delaySeconds: Math.max(0, Math.min(365, Number(e.target.value) || 0)) * DAY_SECONDS,
                  })
                }
              />
            )}
          </Field>
          {step.type === 'send_message' ? (
            <MessageFields
              step={step}
              index={i}
              errors={props.errors}
              disabled={props.disabled}
              onChange={(s) => update(i, s)}
            />
          ) : (
            <ConditionFields step={step} disabled={props.disabled} onChange={(s) => update(i, s)} />
          )}
        </section>
      ))}
      <div className="flex gap-2">
        <Button disabled={props.disabled} onClick={() => onChange([...steps, newMessage()])}>
          <Plus size={14} aria-hidden />
          {t('campaigns.addMessage')}
        </Button>
        <Button disabled={props.disabled} onClick={() => onChange([...steps, newCondition()])}>
          <Plus size={14} aria-hidden />
          {t('campaigns.addCondition')}
        </Button>
      </div>
      {props.errors.steps ? <p className="text-xs text-bad">{t('errors.steps.required')}</p> : null}
    </div>
  );
}

type MessageStep = Extract<CampaignStep, { type: 'send_message' }>;
type ConditionStep = Extract<CampaignStep, { type: 'condition' }>;

function MessageFields(props: {
  step: MessageStep;
  index: number;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (step: MessageStep) => void;
}) {
  const { t } = useTranslation();
  const { step, index } = props;
  const hint = t('campaigns.placeholdersHint', {
    fields: templateFields.map((f) => `{{${f}}}`).join(', '),
    example: '{{companyName|your team}}',
  });
  return (
    <>
      <Field label={t('campaigns.channel')} className="max-w-md">
        {(id) => (
          <Select id={id} value={step.channel} disabled>
            <option value="test">{t('campaigns.channels.test')}</option>
          </Select>
        )}
      </Field>
      <Field label={t('campaigns.subject')} errorKey={props.errors[`steps.${index}.subject`]}>
        {(id, describedBy) => (
          <Input
            id={id}
            value={step.subject}
            disabled={props.disabled}
            aria-describedby={describedBy}
            aria-invalid={props.errors[`steps.${index}.subject`] ? true : undefined}
            onChange={(e) => props.onChange({ ...step, subject: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('campaigns.body')} errorKey={props.errors[`steps.${index}.body`]} hint={hint}>
        {(id, describedBy) => (
          <textarea
            id={id}
            className={cn(textarea)}
            value={step.body}
            disabled={props.disabled}
            aria-describedby={describedBy}
            aria-invalid={props.errors[`steps.${index}.body`] ? true : undefined}
            onChange={(e) => props.onChange({ ...step, body: e.target.value })}
          />
        )}
      </Field>
    </>
  );
}

function ConditionFields(props: {
  step: ConditionStep;
  disabled: boolean;
  onChange: (step: ConditionStep) => void;
}) {
  const { t } = useTranslation();
  const { step } = props;
  const setRule = (i: number, rule: Condition) =>
    props.onChange({ ...step, conditions: step.conditions.map((c, j) => (j === i ? rule : c)) });
  return (
    <div className="grid gap-2">
      {step.conditions.map((rule, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t('campaigns.conditionField')}
            className="w-48"
            value={rule.field}
            disabled={props.disabled}
            onChange={(e) => setRule(i, { ...rule, field: conditionFieldSchema.parse(e.target.value) })}
          >
            {conditionFieldSchema.options.map((f) => (
              <option key={f} value={f}>
                {t(`campaigns.fields.${f}`)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t('campaigns.conditionOp')}
            className="w-36"
            value={rule.op}
            disabled={props.disabled}
            onChange={(e) => setRule(i, { ...rule, op: conditionOpSchema.parse(e.target.value) })}
          >
            {conditionOpSchema.options.map((op) => (
              <option key={op} value={op}>
                {t(`campaigns.ops.${op}`)}
              </option>
            ))}
          </Select>
          {rule.op === 'exists' || rule.op === 'not_exists' ? null : (
            <Input
              aria-label={t('campaigns.conditionValue')}
              className="w-48"
              value={rule.value ?? ''}
              disabled={props.disabled}
              onChange={(e) => setRule(i, { ...rule, value: e.target.value })}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={props.disabled || step.conditions.length === 1}
            onClick={() => props.onChange({ ...step, conditions: step.conditions.filter((_, j) => j !== i) })}
            aria-label={t('campaigns.removeRule')}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={props.disabled || step.conditions.length >= 10}
          onClick={() =>
            props.onChange({
              ...step,
              conditions: [...step.conditions, { field: 'company.country', op: 'eq', value: '' }],
            })
          }
        >
          {t('campaigns.addRule')}
        </Button>
        <Field label={t('campaigns.onFalse')} className="w-64">
          {(id) => (
            <Select
              id={id}
              value={step.onFalse}
              disabled={props.disabled}
              onChange={(e) =>
                props.onChange({ ...step, onFalse: e.target.value === 'skip' ? 'skip' : 'stop' })
              }
            >
              <option value="stop">{t('campaigns.onFalseOptions.stop')}</option>
              <option value="skip">{t('campaigns.onFalseOptions.skip')}</option>
            </Select>
          )}
        </Field>
      </div>
    </div>
  );
}
