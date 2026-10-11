import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { Alert, Button } from '../../components/ui';
import { translateKey } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';
import { ResearchResult } from '../companies/ResearchSection';

/**
 * Research about the person on their company's own site (docs/16 "Research about a person"): only
 * pages that name them, facts with verified quotes. LinkedIn and other sites are not read.
 */
export function PersonResearch({ contactId, companyId }: { contactId: string; companyId: string | null }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ['research', 'contact', contactId],
    queryFn: () => call('research.listForContact', { contactId }),
  });
  const latest = runs.data?.items[0];
  const detail = useQuery({
    queryKey: ['research', 'run', latest?.id],
    queryFn: () => call('research.get', { id: latest?.id as string }),
    enabled: Boolean(latest),
  });
  const start = useMutation({
    mutationFn: () => call('research.start', { companyId: companyId as string, contactId }),
    onSuccess: () => invalidateEntities(qc, ['research', 'activity']),
  });
  const busy = latest?.status === 'pending' || latest?.status === 'running';
  return (
    <section
      aria-labelledby="person-research-heading"
      className="grid min-w-0 gap-3 rounded-md border border-rule bg-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="person-research-heading" className="text-[14px] font-semibold">
          {t('research.person.title')}
        </h2>
        {latest ? (
          <span className="font-mono text-[11px] text-faint">
            {t(`research.statuses.${latest.status}`)} · {formatDateTime(latest.startedAt, i18n.language)}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-soft">{t('research.person.hint')}</p>
      <Button
        className="justify-self-start"
        onClick={() => start.mutate()}
        disabled={!companyId || busy || start.isPending}
      >
        <Search size={14} aria-hidden />
        {busy ? t('research.running') : t('research.person.start')}
      </Button>
      {!companyId ? <p className="text-xs text-faint">{t('research.person.noCompany')}</p> : null}
      {start.isError ? <Alert>{errorMessage(t, start.error)}</Alert> : null}
      {runs.error ? <Alert>{errorMessage(t, runs.error)}</Alert> : null}
      {latest?.status === 'failed' && latest.error ? (
        <Alert tone="warn">{translateKey(t, `errors.${latest.error}`, t('errors.generic'))}</Alert>
      ) : null}
      {detail.data && detail.data.status === 'completed' ? <ResearchResult run={detail.data} /> : null}
    </section>
  );
}
