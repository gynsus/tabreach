import { useQuery } from '@tanstack/react-query';
import type { ActionEvent } from '@tabreach/protocol';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { translateKey } from '../i18n';
import { call } from '../lib/api';

export function describeEvent(t: TFunction, event: ActionEvent): { title: string; detail: string | null } {
  const title =
    event.actionType === 'message.send'
      ? translateKey(t, `activity.messageSend.${event.status}`, event.actionType)
      : translateKey(t, `activity.actions.${event.actionType}`, event.actionType);
  const p = event.payload;
  if (event.actionType === 'import.committed') {
    return { title, detail: t('activity.importSummary', p as Record<string, number>) };
  }
  if (Array.isArray(p.fields) && p.fields.length > 0) {
    const fields = (p.fields as string[]).map((f) => translateKey(t, `fieldNames.${f}`, f)).join(', ');
    return { title, detail: t('activity.changedFields', { fields }) };
  }
  if (typeof p.value === 'string') return { title, detail: p.value };
  return { title, detail: null };
}

export function formatDateTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** History of one company or contact, backed by the audit trail (FR-AUD-002). */
export function Timeline(props: { objectType: 'company' | 'contact'; objectId: string }) {
  const { t, i18n } = useTranslation();
  const query = useQuery({
    queryKey: ['activity', props.objectType, props.objectId],
    queryFn: () =>
      call('activity.list', { objectType: props.objectType, objectId: props.objectId, limit: 50 }),
  });
  const events = query.data?.items ?? [];
  return (
    <section className="grid content-start gap-3" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="text-[13px] font-semibold">
        {t('common.history')}
      </h2>
      {events.length === 0 ? (
        <p className="text-[13px] text-faint">
          {query.isPending ? t('common.loading') : t('activity.empty')}
        </p>
      ) : (
        <ol className="grid gap-2.5 border-l border-rule pl-4">
          {events.map((event) => {
            const d = describeEvent(t, event);
            return (
              <li key={event.id} className="grid gap-0.5 text-[13px]">
                <span className="font-medium">{d.title}</span>
                {d.detail ? <span className="text-soft">{d.detail}</span> : null}
                <span className="font-mono text-[11px] text-faint">
                  {formatDateTime(event.createdAt, i18n.language)} ·{' '}
                  {translateKey(t, `activity.actors.${event.actorType}`, event.actorType)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
