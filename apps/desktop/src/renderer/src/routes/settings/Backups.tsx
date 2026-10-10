import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Backup } from '@tabreach/protocol';
import { Archive, Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../components/Timeline';
import { useToast } from '../../components/toast';
import { Alert, Badge, Button, Modal } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';

const MB = 1024 * 1024;

/**
 * Local recovery backups and the portable export (FR-APP-005, ADR 029). A restore restarts the
 * app's core onto the backup; it then starts paused.
 */
export function BackupsSection() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['settings', 'backups'], queryFn: () => call('backup.list', {}) });
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings', 'backups'] });

  const create = useMutation({
    mutationFn: () => call('backup.create', {}),
    onSuccess: async () => {
      toast(t('settings.backups.created'));
      await refresh();
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const remove = useMutation({
    mutationFn: (name: string) => call('backup.delete', { name }),
    onSuccess: refresh,
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const exportCopy = useMutation({
    mutationFn: () => call('backup.exportPortable', {}),
    onSuccess: (r) => {
      if (r.saved) toast(t('settings.backups.exported'));
    },
    onError: (error) => toast(errorMessage(t, error), 'bad'),
  });
  const restore = useMutation({
    mutationFn: (name: string) => call('backup.restore', { name }),
    onSuccess: () => setRestoring(null),
  });

  const data = list.data;
  const last = data?.lastRestore;
  return (
    <section aria-labelledby="backups-heading" className="grid gap-3" data-testid="backups">
      <div className="grid gap-1">
        <h2 id="backups-heading" className="text-[15px] font-semibold">
          {t('settings.backups.title')}
        </h2>
        <p className="text-[13px] text-soft">{t('settings.backups.subtitle')}</p>
      </div>
      {last ? (
        <Alert tone={last.ok ? 'ok' : 'bad'}>
          {last.ok
            ? t('settings.backups.restoredOk', { at: formatDateTime(last.at, i18n.language) })
            : t('settings.backups.restoreFailed', { at: formatDateTime(last.at, i18n.language) })}
        </Alert>
      ) : null}
      {list.isError ? <Alert>{errorMessage(t, list.error)}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          <Archive size={14} aria-hidden />
          {create.isPending ? t('settings.backups.creating') : t('settings.backups.create')}
        </Button>
        <Button variant="secondary" onClick={() => exportCopy.mutate()} disabled={exportCopy.isPending}>
          <Download size={14} aria-hidden />
          {t('settings.backups.export')}
        </Button>
      </div>
      <p className="text-xs text-faint">{t('settings.backups.exportHint')}</p>
      {data && data.items.length === 0 ? (
        <p className="text-[13px] text-soft">{t('settings.backups.none')}</p>
      ) : null}
      {data && data.items.length > 0 ? (
        <table className="w-full max-w-2xl text-[13px]">
          <thead>
            <tr className="text-left text-xs text-soft">
              <th className="py-1 font-medium">{t('settings.backups.when')}</th>
              <th className="py-1 font-medium">{t('settings.backups.kind')}</th>
              <th className="py-1 font-medium">{t('settings.backups.size')}</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {data.items.map((b) => {
              const newer = b.schemaVersion !== null && b.schemaVersion > data.schemaVersion;
              const unreadable = b.schemaVersion === null;
              return (
                <tr key={b.name} className="border-t border-rule" data-testid="backup-row">
                  <td className="py-1.5">{formatDateTime(b.createdAt, i18n.language)}</td>
                  <td className="py-1.5">
                    <Badge>{t(`settings.backups.kinds.${b.kind}`)}</Badge>
                  </td>
                  <td className="py-1.5 tabular-nums">{(b.bytes / MB).toFixed(1)} MB</td>
                  <td className="flex justify-end gap-1 py-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={newer || unreadable}
                      title={
                        newer
                          ? t('errors.backup.newerApp')
                          : unreadable
                            ? t('errors.backup.unreadable')
                            : undefined
                      }
                      onClick={() => {
                        restore.reset();
                        setRestoring(b);
                      }}
                    >
                      {t('settings.backups.restore')}
                    </Button>
                    {b.kind === 'manual' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(b.name)}
                      >
                        {t('settings.backups.delete')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <Modal
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        busy={restore.isPending}
        title={t('settings.backups.confirmTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoring(null)} disabled={restore.isPending}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => restoring && restore.mutate(restoring.name)} disabled={restore.isPending}>
              {t('settings.backups.confirm')}
            </Button>
          </>
        }
      >
        <div className="grid gap-2 text-[13px]">
          <p>
            {t('settings.backups.confirmBody', {
              at: restoring ? formatDateTime(restoring.createdAt, i18n.language) : '',
            })}
          </p>
          <ul className="list-disc pl-5 text-soft">
            <li>{t('settings.backups.confirmKept')}</li>
            <li>{t('settings.backups.confirmPaused')}</li>
            <li>{t('settings.backups.confirmUndo')}</li>
          </ul>
          {restore.isError ? <Alert>{errorMessage(t, restore.error)}</Alert> : null}
        </div>
      </Modal>
    </section>
  );
}
