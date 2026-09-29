import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Timeline, formatDateTime } from '../../components/Timeline';
import { Alert, Badge, Button, DetailList, PageHeader, Tags } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { invalidateEntities } from '../../lib/live';
import { ContactForm } from './ContactForm';

export function ContactPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const query = useQuery({ queryKey: ['contact', id], queryFn: () => call('contacts.get', { id }) });
  const c = query.data;

  if (query.isError) {
    return (
      <div className="p-6">
        <Alert>{errorMessage(t, query.error)}</Alert>
      </div>
    );
  }
  if (!c) return <p className="p-6 text-soft">{t('common.loading')}</p>;

  const none = <span className="text-faint">{t('common.none')}</span>;
  return (
    <>
      <PageHeader
        title={c.displayName}
        subtitle={
          <span className="flex items-center gap-2">
            {c.jobTitle ? <span>{c.jobTitle}</span> : null}
            {c.companyId ? (
              <Link to={`/companies/${c.companyId}`} className="text-accent hover:underline">
                {c.companyName}
              </Link>
            ) : null}
            {c.status === 'archived' ? <Badge tone="warn">{t('common.archived')}</Badge> : null}
          </span>
        }
        actions={
          <>
            <Link
              to="/contacts"
              className="inline-flex items-center gap-1 text-[13px] text-soft hover:text-ink"
            >
              <ArrowLeft size={14} aria-hidden />
              {t('contacts.title')}
            </Link>
            <Button onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden />
              {t('common.edit')}
            </Button>
          </>
        }
      />
      <div className="grid flex-1 grid-cols-1 content-start items-start gap-8 overflow-y-auto p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <DetailList
          items={[
            { label: t('contacts.email'), value: c.email ?? none },
            {
              label: t('contacts.linkedin'),
              value: c.linkedinUrl ? <span className="font-mono text-xs">{c.linkedinUrl}</span> : none,
            },
            { label: t('contacts.company'), value: c.companyName ?? none },
            { label: t('prospects.timezone'), value: c.timezone ?? none },
            { label: t('contacts.tags'), value: c.tags.length ? <Tags tags={c.tags} /> : none },
            ...Object.entries(c.customFields).map(([k, v]) => ({ label: k, value: String(v) })),
            { label: t('common.created'), value: formatDateTime(c.createdAt, i18n.language) },
            { label: t('common.updated'), value: formatDateTime(c.updatedAt, i18n.language) },
          ]}
        />
        <ReplyHold contactId={c.id} />
        <Timeline scope={{ contactId: c.id }} refs={['campaign']} />
      </div>
      {editing ? <ContactForm open contact={c} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

/** A contact who (or whose company) replied is on hold for every campaign until the user allows it. */
function ReplyHold({ contactId }: { contactId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const hold = useQuery({
    queryKey: ['contact', contactId, 'hold'],
    queryFn: () => call('contacts.replyHold', { id: contactId }),
  });
  const release = useMutation({
    mutationFn: () => call('contacts.releaseReplyHold', { id: contactId }),
    onSuccess: () => invalidateEntities(qc, ['contact', 'activity']),
  });
  const reason = hold.data?.hold;
  if (!reason) return null;
  return (
    <div
      className="grid gap-2 rounded-md bg-warn-bg px-4 py-3 text-[13px] text-warn"
      data-testid="reply-hold"
    >
      <p>{t(`contacts.replyHold.${reason}`)}</p>
      <Button
        size="sm"
        className="justify-self-start"
        onClick={() => release.mutate()}
        disabled={release.isPending}
      >
        {t('contacts.replyHold.release')}
      </Button>
      {release.isError ? <Alert>{errorMessage(t, release.error)}</Alert> : null}
    </div>
  );
}
