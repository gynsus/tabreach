import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Button } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';

/**
 * The sanitized diagnostics bundle (docs/20, FR-BRA-007): versions, redacted logs, events and
 * state, plus only the screenshots the person ticks. Saved where they choose; nothing is uploaded.
 */
export function DiagnosticsSection() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const shots = useQuery({
    queryKey: ['browser', 'diagnostics'],
    queryFn: () => call('diagnostics.screenshots', {}),
  });
  const [chosen, setChosen] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: async () => {
      const bundle = await call('diagnostics.createBundle', { screenshots: chosen });
      const saved = await window.tabreach.saveTextFile({
        suggestedName: bundle.filename,
        content: bundle.base64,
        encoding: 'base64',
      });
      return { ...saved, contents: bundle.contents };
    },
    onSuccess: (r) => {
      if (r.saved) toast(t('status.diagnostics.saved', { count: r.contents.length }));
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const items = shots.data?.items ?? [];
  const toggle = (file: string) =>
    setChosen((now) => (now.includes(file) ? now.filter((f) => f !== file) : [...now, file]));

  return (
    <section
      aria-labelledby="diagnostics-heading"
      className="grid gap-3 rounded-md border border-rule bg-raised p-4 text-[13px]"
      data-testid="diagnostics"
    >
      <h2 id="diagnostics-heading" className="text-[14px] font-semibold">
        {t('status.diagnostics.heading')}
      </h2>
      <p className="text-soft">{t('status.diagnostics.body')}</p>
      {shots.isError ? <Alert>{errorMessage(t, shots.error)}</Alert> : null}
      {items.length ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-xs font-medium text-soft">
            {t('status.diagnostics.screenshots')}
          </legend>
          {items.slice(0, 20).map((s) => (
            <label key={s.file} className="flex items-center gap-2">
              <input type="checkbox" checked={chosen.includes(s.file)} onChange={() => toggle(s.file)} />
              <span>{formatDateTime(s.takenAt, i18n.language)}</span>
              <span className="font-mono text-[12px] text-faint">
                {[s.packId, s.stateId ?? s.errorKey].filter(Boolean).join(' · ')}
              </span>
            </label>
          ))}
          <span className="text-xs text-faint">{t('status.diagnostics.screenshotsHint')}</span>
        </fieldset>
      ) : null}
      <div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          <Download size={14} aria-hidden />
          {create.isPending ? t('status.diagnostics.creating') : t('status.diagnostics.create')}
        </Button>
      </div>
    </section>
  );
}
