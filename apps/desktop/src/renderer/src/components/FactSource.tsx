import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../lib/api';
import { formatDateTime } from './Timeline';
import { Alert, Button, Modal } from './ui';

/** "Show in source": the page a fact came from, as captured, with its quote highlighted (FR-RES-005). */
export function FactSourceButton({ factId }: { factId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setOpen(true)}>
        <FileText size={13} aria-hidden />
        {t('research.source.show')}
      </Button>
      {open ? <FactSourceModal factId={factId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function FactSourceModal({ factId, onClose }: { factId: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const source = useQuery({
    queryKey: ['research', 'factSource', factId],
    queryFn: () => call('research.factSource', { factId }),
  });
  const mark = useRef<HTMLElement>(null);
  const s = source.data;
  useEffect(() => {
    mark.current?.scrollIntoView({ block: 'center' });
  }, [s]);
  return (
    <Modal open wide onClose={onClose} title={t('research.source.title')}>
      {source.isError ? <Alert>{errorMessage(t, source.error)}</Alert> : null}
      {s ? (
        <div className="grid gap-3 text-[13px]">
          <div className="grid gap-0.5">
            <span className="font-medium">{s.claim}</span>
            <span className="font-mono text-[11px] break-all text-soft">{s.url}</span>
            <span className="text-xs text-faint">
              {t('research.source.captured', {
                at: formatDateTime(s.capturedAt, i18n.language),
                title: s.title ?? '—',
              })}{' '}
              ·{' '}
              {t(
                `research.source.extractors.${s.extractor === 'rendered-readability' ? 'rendered' : 'static'}`,
              )}
            </span>
          </div>
          {s.text === null ? (
            <Alert tone="warn">{t('research.source.removed', { quote: s.quote ?? '' })}</Alert>
          ) : (
            <>
              {s.highlight ? null : <Alert tone="warn">{t('research.source.notPlaced')}</Alert>}
              <div
                data-testid="fact-source-text"
                className="max-h-[55vh] overflow-y-auto rounded-md border border-rule bg-sunken px-3 py-2 leading-relaxed whitespace-pre-wrap"
              >
                {s.omittedBefore > 0 ? (
                  <p className="text-xs text-faint">
                    {t('research.source.omitted', { count: s.omittedBefore })}
                  </p>
                ) : null}
                {s.highlight ? (
                  <>
                    {s.text.slice(0, s.highlight.start)}
                    <mark ref={mark} className="rounded-sm bg-accent-soft px-0.5 text-ink">
                      {s.text.slice(s.highlight.start, s.highlight.end)}
                    </mark>
                    {s.text.slice(s.highlight.end)}
                  </>
                ) : (
                  s.text
                )}
                {s.omittedAfter > 0 ? (
                  <p className="text-xs text-faint">
                    {t('research.source.omitted', { count: s.omittedAfter })}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-soft">{t('common.loading')}</p>
      )}
    </Modal>
  );
}
