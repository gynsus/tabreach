import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiSettings as Settings, AiUseCase } from '@tabreach/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, Field, Input } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage, fieldErrors } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

const USE_CASES: AiUseCase[] = ['classification', 'research', 'drafting'];

/** AI provider key (BYOK), models per use case, prices, budget and this month's usage (docs/15). */
export function AiSettings() {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ['settings', 'ai'], queryFn: () => call('ai.settings.get', {}) });
  if (settings.isError) return <Alert>{errorMessage(t, settings.error)}</Alert>;
  if (!settings.data) return null;
  return (
    <section aria-labelledby="ai-heading" className="grid gap-5">
      <div className="grid gap-1">
        <h2 id="ai-heading" className="text-[15px] font-semibold">
          {t('ai.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('ai.subtitle')}</p>
      </div>
      <ApiKey keySet={settings.data.keySet} />
      <ModelsAndBudget initial={settings.data} />
      <Usage />
    </section>
  );
}

function ApiKey({ keySet }: { keySet: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState('');
  const refresh = () => invalidateEntities(qc, ['settings', 'activity']);
  const save = useMutation({
    mutationFn: () => call('ai.setKey', { apiKey: key }),
    onSuccess: async () => {
      setKey('');
      await refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => call('ai.removeKey', {}), onSuccess: refresh });
  const test = useMutation({
    mutationFn: () => call('ai.testKey', {}),
    onSuccess: (r) =>
      toast(
        r.ok
          ? t('ai.keyWorks')
          : translateKey(t, `ai.errors.${r.error ?? 'unavailable'}`, t('errors.generic')),
        r.ok ? 'ok' : 'bad',
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate();
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-medium">{t('ai.key')}</span>
        <Badge tone={keySet ? 'ok' : 'neutral'}>{keySet ? t('ai.keySet') : t('ai.keyMissing')}</Badge>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <Field
          label={t('ai.newKey')}
          hint={t('ai.keyHint')}
          errorKey={fieldErrors(save.error).apiKey}
          className="w-96"
        >
          {(id, describedBy) => (
            <Input
              id={id}
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              value={key}
              aria-describedby={describedBy}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
          {t('common.save')}
        </Button>
        {keySet ? (
          <>
            <Button onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? t('common.loading') : t('ai.testKey')}
            </Button>
            <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {t('ai.removeKey')}
            </Button>
          </>
        ) : null}
      </form>
      {save.isError ? <Alert>{errorMessage(t, save.error)}</Alert> : null}
    </div>
  );
}

function ModelsAndBudget({ initial }: { initial: Settings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
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
        <p className="text-xs text-faint">{t('ai.pricesHint')}</p>
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
      <Button
        variant="primary"
        className="justify-self-start"
        onClick={() => save.mutate()}
        disabled={save.isPending}
      >
        {save.isPending ? t('common.saving') : t('common.save')}
      </Button>
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
