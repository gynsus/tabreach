import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_AI_MODELS,
  type AiProviderName,
  type AiSettings as Settings,
  type AiUseCase,
} from '@tabreach/protocol';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import {
  Alert,
  Badge,
  Button,
  Field,
  Input,
  Loading,
  SaveBar,
  UnsavedChangesPrompt,
} from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useDraft } from '../../lib/draft';
import { invalidateEntities } from '../../lib/live';

const USE_CASES: AiUseCase[] = ['classification', 'research', 'drafting'];

/** AI provider key (BYOK), models per use case, prices, budget and this month's usage (docs/15). */
export function AiSettings() {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ['settings', 'ai'], queryFn: () => call('ai.settings.get', {}) });
  if (settings.isError) return <Alert>{errorMessage(t, settings.error)}</Alert>;
  if (!settings.data) return <Loading />;
  return (
    <section aria-labelledby="ai-heading" className="grid gap-5">
      <div className="grid gap-1">
        <h2 id="ai-heading" className="text-[15px] font-semibold">
          {t('ai.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('ai.subtitle')}</p>
      </div>
      <ProviderPicker settings={settings.data} />
      <ApiKey key={`key-${settings.data.provider}`} settings={settings.data} />
      <ModelsAndBudget key={`models-${settings.data.provider}`} initial={settings.data} />
      <Usage />
    </section>
  );
}

const PROVIDERS: AiProviderName[] = ['anthropic', 'openrouter', 'openai'];
const KEY_PREFIX: Record<AiProviderName, string> = {
  anthropic: 'sk-ant-…',
  openrouter: 'sk-or-v1-…',
  openai: 'sk-…',
};

/** Which provider TabReach calls; switching also suggests that provider's models. */
function ProviderPicker({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const choose = useMutation({
    mutationFn: (provider: AiProviderName) =>
      call('ai.settings.update', {
        provider,
        models: DEFAULT_AI_MODELS[provider],
        prices: settings.prices,
        monthlyBudgetUsd: settings.monthlyBudgetUsd,
      }),
    onSuccess: () => invalidateEntities(qc, ['settings', 'activity']),
  });
  return (
    <>
      {choose.isError ? <Alert>{errorMessage(t, choose.error)}</Alert> : null}
      <div role="radiogroup" aria-label={t('ai.provider')} className="grid grid-cols-3 gap-2">
        {PROVIDERS.map((p) => {
          const selected = settings.provider === p;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-provider={p}
              disabled={choose.isPending}
              onClick={() => !selected && choose.mutate(p)}
              onKeyDown={(e) => {
                // Arrow keys choose the next provider (WAI-ARIA radio group pattern).
                const step =
                  e.key === 'ArrowRight' || e.key === 'ArrowDown'
                    ? 1
                    : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                      ? -1
                      : 0;
                if (!step) return;
                e.preventDefault();
                const next = PROVIDERS[(PROVIDERS.indexOf(p) + step + PROVIDERS.length) % PROVIDERS.length]!;
                choose.mutate(next);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLElement>(`[data-provider="${next}"]`)?.focus(),
                );
              }}
              className={cn(
                'grid gap-1 rounded-md border px-3 py-2.5 text-left text-[13px]',
                selected ? 'border-accent bg-accent-soft' : 'border-rule bg-raised hover:border-accent',
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                {t(`ai.providers.${p}.name`)}
                {settings.keys[p] ? <Badge tone="ok">{t('ai.hasKey')}</Badge> : null}
              </span>
              <span className="text-xs text-soft">{t(`ai.providers.${p}.description`)}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function ApiKey({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { provider, keySet, keyHint } = settings;
  const [key, setKey] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const refresh = () => invalidateEntities(qc, ['settings', 'activity']);
  const test = useMutation({ mutationFn: () => call('ai.testKey', {}) });
  const save = useMutation({
    mutationFn: () => call('ai.setKey', { provider, apiKey: key.trim() }),
    onSuccess: async () => {
      setKey('');
      setJustSaved(true);
      test.reset();
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => call('ai.removeKey', { provider }),
    onSuccess: async () => {
      setConfirmRemove(false);
      setJustSaved(false);
      test.reset();
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate();
  };
  const result = test.data;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{t('ai.key')}</span>
        <Badge tone={keySet ? 'ok' : 'neutral'}>{keySet ? t('ai.keySet') : t('ai.keyMissing')}</Badge>
        {keyHint ? (
          <span className="font-mono text-xs text-soft" data-testid="ai-key-hint">
            {keyHint}
          </span>
        ) : null}
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field
          label={t('ai.newKey')}
          hint={t(`ai.keyHints.${provider}`)}
          errorKey={fieldErrors(save.error).apiKey}
          className="w-96"
        >
          {(id, describedBy) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              placeholder={KEY_PREFIX[provider]}
              value={key}
              aria-describedby={describedBy}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
          {save.isPending ? t('common.saving') : keySet ? t('ai.replaceKey') : t('common.save')}
        </Button>
        {keySet ? (
          <>
            <Button
              variant={justSaved && !result ? 'primary' : 'secondary'}
              onClick={() => test.mutate()}
              disabled={test.isPending}
            >
              {test.isPending ? t('ai.testing') : t('ai.testKey')}
            </Button>
            {confirmRemove ? (
              <span className="flex items-center gap-1">
                <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  {t('ai.confirmRemoveKey')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                  {t('common.cancel')}
                </Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
                {t('ai.removeKey')}
              </Button>
            )}
          </>
        ) : null}
      </form>
      <div role="status" className="text-[13px]">
        {result?.ok ? <p className="text-ok">{t('ai.keyWorks')}</p> : null}
        {result && !result.ok ? (
          <p className="text-bad">
            {translateKey(t, `ai.errors.${result.error ?? 'unavailable'}`, t('errors.generic'))}
          </p>
        ) : null}
        {test.isError ? <p className="text-bad">{errorMessage(t, test.error)}</p> : null}
        {justSaved && !result && !test.isPending ? (
          <p className="text-soft">{t('ai.savedCheckNow')}</p>
        ) : null}
      </div>
      {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
      {remove.isError ? <Alert>{errorMessage(t, remove.error)}</Alert> : null}
    </div>
  );
}

type Editable = Pick<Settings, 'provider' | 'models' | 'prices' | 'monthlyBudgetUsd'>;

function ModelsAndBudget({ initial }: { initial: Settings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const { value, setValue, dirty, reset } = useDraft<Editable>({
    provider: initial.provider,
    models: initial.models,
    prices: initial.prices,
    monthlyBudgetUsd: initial.monthlyBudgetUsd,
  });
  const save = useMutation({
    mutationFn: () =>
      call('ai.settings.update', {
        provider: value.provider,
        models: value.models,
        prices: value.prices,
        monthlyBudgetUsd: value.monthlyBudgetUsd,
      }),
    onSuccess: async () => {
      toast(t('ai.saved'));
      await invalidateEntities(qc, ['settings', 'activity']);
    },
  });
  const models = [...new Set(Object.values(value.models))];
  const price = (model: string, side: 'inputPerMTok' | 'outputPerMTok') => value.prices[model]?.[side] ?? '';
  const setPrice = (model: string, side: 'inputPerMTok' | 'outputPerMTok', raw: string) => {
    const current = value.prices[model] ?? { inputPerMTok: 0, outputPerMTok: 0 };
    const prices = { ...value.prices };
    if (raw === '' && !value.prices[model]?.[side === 'inputPerMTok' ? 'outputPerMTok' : 'inputPerMTok'])
      delete prices[model];
    else prices[model] = { ...current, [side]: Math.max(0, Number(raw) || 0) };
    setValue({ ...value, prices });
  };
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-3">
        {USE_CASES.map((useCase) => (
          <Field key={useCase} label={t(`ai.useCases.${useCase}`)}>
            {(id) => (
              <Input
                id={id}
                value={value.models[useCase]}
                onChange={(e) =>
                  setValue({ ...value, models: { ...value.models, [useCase]: e.target.value.trim() } })
                }
              />
            )}
          </Field>
        ))}
      </div>
      <div className="grid gap-2">
        <p className="text-xs font-medium text-soft">{t('ai.prices')}</p>
        <p className="text-xs text-faint">
          {value.provider === 'openrouter' ? t('ai.pricesHintOpenRouter') : t('ai.pricesHint')}
        </p>
        {models.map((model) => (
          <div key={model} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="w-64 truncate font-mono text-xs">{model}</span>
            <Input
              aria-label={`${model} · ${t('ai.inputPrice')}`}
              placeholder={t('ai.inputPrice')}
              type="number"
              min={0}
              step="0.01"
              className="w-28"
              value={price(model, 'inputPerMTok')}
              onChange={(e) => setPrice(model, 'inputPerMTok', e.target.value)}
            />
            <Input
              aria-label={`${model} · ${t('ai.outputPrice')}`}
              placeholder={t('ai.outputPrice')}
              type="number"
              min={0}
              step="0.01"
              className="w-28"
              value={price(model, 'outputPerMTok')}
              onChange={(e) => setPrice(model, 'outputPerMTok', e.target.value)}
            />
            <span className="text-xs text-faint">{t('ai.perMTok')}</span>
          </div>
        ))}
      </div>
      <Field label={t('ai.budget')} hint={t('ai.budgetHint')} className="w-64">
        {(id, describedBy) => (
          <Input
            id={id}
            type="number"
            min={0}
            step="1"
            aria-describedby={describedBy}
            value={value.monthlyBudgetUsd ?? ''}
            onChange={(e) =>
              setValue({
                ...value,
                monthlyBudgetUsd: e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
              })
            }
          />
        )}
      </Field>
      {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
      <SaveBar dirty={dirty} saving={save.isPending} onSave={() => save.mutate()} onDiscard={reset} />
      <UnsavedChangesPrompt when={dirty && !save.isPending} />
    </div>
  );
}

function Usage() {
  const { t, i18n } = useTranslation();
  const usage = useQuery({ queryKey: ['settings', 'ai', 'usage'], queryFn: () => call('ai.usage', {}) });
  const u = usage.data;
  if (!u) return null;
  const n = (v: number) => new Intl.NumberFormat(i18n.language).format(v);
  const cost =
    u.costUsd === null
      ? t('ai.costUnknown')
      : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(u.costUsd);
  return (
    <div className="grid gap-1 rounded-md bg-sunken px-4 py-3 text-[13px]" data-testid="ai-usage">
      <p className="font-medium">{t('ai.usageTitle', { month: u.month })}</p>
      <p className="text-soft">
        {t('ai.usageLine', { calls: n(u.calls), input: n(u.inputTokens), output: n(u.outputTokens), cost })}
        {u.budgetUsd !== null ? ` · ${t('ai.budgetOf', { budget: n(u.budgetUsd) })}` : ''}
      </p>
      {u.failed > 0 ? <p className="text-xs text-warn">{t('ai.failedCalls', { count: u.failed })}</p> : null}
    </div>
  );
}
