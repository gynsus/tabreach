import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Intervention } from '@tabreach/protocol';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Button } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';

/** Open requests to the person (docs/11), shared with the navigation badge. */
export function useInterventions() {
  return useQuery({ queryKey: ['profiles', 'interventions'], queryFn: () => call('interventions.list', {}) });
}

/** "Needs you": challenges to solve and pages TabReach does not recognize (docs/11, docs/19). */
export function Interventions() {
  const { t } = useTranslation();
  const list = useInterventions();
  const items = list.data?.items ?? [];
  if (list.isError) return <Alert>{errorMessage(t, list.error)}</Alert>;
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="interventions-heading" className="grid gap-3">
      <h2 id="interventions-heading" className="text-[15px] font-semibold">
        {t('interventions.title')}
      </h2>
      <ul className="grid gap-3">
        {items.map((i) => (
          <InterventionItem key={i.id} item={i} />
        ))}
      </ul>
    </section>
  );
}

function InterventionItem({ item: i }: { item: Intervention }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => invalidateEntities(qc, ['browser', 'activity']);
  const resolve = useMutation({
    mutationFn: (outcome: 'done' | 'cancel') => call('interventions.resolve', { id: i.id, outcome }),
    onSuccess: refresh,
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const focus = useMutation({
    mutationFn: () => call('profiles.focus', { id: i.profileId as string }),
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  return (
    <li
      className="grid gap-2 rounded-md border border-warn bg-warn-bg p-4 text-[13px]"
      data-testid="intervention"
    >
      <p className="font-medium">
        {t(`interventions.reasons.${i.reason}`, { profile: i.profileName ?? '—' })}
      </p>
      <p className="text-soft">{t(`interventions.instructions.${i.reason}`)}</p>
      {i.url ? <p className="truncate font-mono text-[11px] text-faint">{i.url}</p> : null}
      <p className="font-mono text-[11px] text-faint">{formatDateTime(i.requestedAt, i18n.language)}</p>
      <div className="flex flex-wrap gap-2">
        {i.sessionOpen && i.profileId ? (
          <Button size="sm" onClick={() => focus.mutate()} disabled={focus.isPending}>
            {t('browser.showWindow')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          onClick={() => resolve.mutate('done')}
          disabled={resolve.isPending || !i.sessionOpen}
        >
          {t('interventions.done')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => resolve.mutate('cancel')}
          disabled={resolve.isPending}
        >
          {t('interventions.cancel')}
        </Button>
      </div>
      {i.diagnostics ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-soft">{t('interventions.diagnostics')}</summary>
          <p className="mt-2 text-soft">
            {t('interventions.expected')}:{' '}
            <span className="font-mono">{i.diagnostics.expectedStates.join(', ')}</span>
          </p>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-sunken p-2 font-mono text-[11px] whitespace-pre-wrap">
            {i.diagnostics.ariaSnapshot || '—'}
          </pre>
        </details>
      ) : null}
    </li>
  );
}
