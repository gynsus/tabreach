import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { Alert } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';

/** A share of unrecognized pages above this says the site changed: the pack needs an update. */
const WARN_SHARE = 0.1;

/**
 * How each adapter pack version fares on real pages over 30 days (FR-LIN-006, docs/22 Phase 7):
 * browser tasks, pages it did not recognize, requests to the person, outcomes it could not verify.
 */
export function PackHealthSection() {
  const { t, i18n } = useTranslation();
  const health = useQuery({ queryKey: ['browser', 'packHealth'], queryFn: () => call('packs.health', {}) });
  const items = health.data?.items ?? [];
  return (
    <section aria-labelledby="packs-heading" className="grid gap-3 text-[13px]" data-testid="pack-health">
      <h2 id="packs-heading" className="text-[15px] font-semibold">
        {t('status.packs.title')}
      </h2>
      <p className="text-soft">{t('status.packs.hint')}</p>
      {health.isError ? <Alert>{errorMessage(t, health.error)}</Alert> : null}
      {health.isSuccess && items.length === 0 ? (
        <p className="text-faint">{t('status.packs.empty')}</p>
      ) : null}
      {items.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem]">
            <caption className="sr-only">{t('status.packs.title')}</caption>
            <thead>
              <tr className="text-left text-xs text-soft">
                <th className="py-1 pr-4 font-medium">{t('status.packs.pack')}</th>
                <th className="py-1 pr-4 font-medium">{t('status.packs.tasks')}</th>
                <th className="py-1 pr-4 font-medium">{t('status.packs.unsupported')}</th>
                <th className="py-1 pr-4 font-medium">{t('status.packs.needsHuman')}</th>
                <th className="py-1 pr-4 font-medium">{t('status.packs.unknown')}</th>
                <th className="py-1 font-medium">{t('status.packs.last')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const share = p.tasks ? p.unsupported / p.tasks : 0;
                return (
                  <tr key={`${p.packId}@${p.version}`} className="border-t border-rule">
                    <td className="py-1.5 pr-4 font-mono text-[12px]">
                      {p.packId} {p.version}
                    </td>
                    <td className="py-1.5 pr-4">{p.tasks}</td>
                    <td className={share > WARN_SHARE ? 'py-1.5 pr-4 font-medium text-warn' : 'py-1.5 pr-4'}>
                      {p.unsupported} ({Math.round(share * 100)}%)
                    </td>
                    <td className="py-1.5 pr-4">{p.needsHuman}</td>
                    <td className="py-1.5 pr-4">{p.unknown}</td>
                    <td className="py-1.5 text-soft">
                      {p.lastUnsupportedAt ? formatDateTime(p.lastUnsupportedAt, i18n.language) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
