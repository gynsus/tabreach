import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';

/**
 * Exports all prospects to CSV, or one campaign's status when `campaignId` is given (FR-PROS-007).
 * Main shows the save dialog (the renderer cannot write files).
 */
export function ExportButton({ campaignId }: { campaignId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const run = useMutation({
    mutationFn: async () => {
      const result = campaignId
        ? await call('exports.campaign', { campaignId })
        : await call('exports.prospects', {});
      const saved = await window.tabreach.saveTextFile({
        suggestedName: result.filename,
        content: result.csv,
      });
      return { ...saved, rows: result.rows };
    },
    onSuccess: (r) => {
      if (r.saved) toast(t('export.saved', { count: r.rows }));
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  return (
    <Button onClick={() => run.mutate()} disabled={run.isPending}>
      <Download size={14} aria-hidden />
      {run.isPending ? t('common.exporting') : t('common.exportCsv')}
    </Button>
  );
}
