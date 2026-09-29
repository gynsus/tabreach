import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Timeline, formatDateTime } from '../../components/Timeline';
import { Alert, Badge, Button, DetailList, PageHeader, Tags } from '../../components/ui';
import { call, errorMessage } from '../../lib/api';
import { ContactForm } from '../contacts/ContactForm';
import { CompanyForm } from './CompanyForm';
import { ResearchSection } from './ResearchSection';

export function CompanyPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const query = useQuery({ queryKey: ['company', id], queryFn: () => call('companies.get', { id }) });
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
        title={c.name}
        subtitle={
          <span className="flex items-center gap-2">
            {c.domain ? <span className="font-mono text-xs">{c.domain}</span> : null}
            <span>{t('companies.contactCount', { count: c.contactCount })}</span>
            {c.status === 'archived' ? <Badge tone="warn">{t('common.archived')}</Badge> : null}
          </span>
        }
        actions={
          <>
            <Link
              to="/companies"
              className="inline-flex items-center gap-1 text-[13px] text-soft hover:text-ink"
            >
              <ArrowLeft size={14} aria-hidden />
              {t('companies.title')}
            </Link>
            <Button onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden />
              {t('common.edit')}
            </Button>
          </>
        }
      />
      <div className="grid flex-1 grid-cols-1 content-start items-start gap-8 overflow-y-auto p-6 lg:grid-cols-[1fr_320px]">
        <div className="grid content-start gap-8">
          <DetailList
            items={[
              { label: t('companies.website'), value: c.websiteUrl ?? none },
              { label: t('companies.country'), value: c.country ?? none },
              { label: t('companies.city'), value: c.city ?? none },
              { label: t('companies.tags'), value: c.tags.length ? <Tags tags={c.tags} /> : none },
              ...Object.entries(c.customFields).map(([k, v]) => ({ label: k, value: String(v) })),
              { label: t('common.created'), value: formatDateTime(c.createdAt, i18n.language) },
            ]}
          />
          <section className="grid gap-3" aria-labelledby="company-contacts">
            <div className="flex items-center justify-between">
              <h2 id="company-contacts" className="text-[13px] font-semibold">
                {t('companies.contacts')}
              </h2>
              <Button size="sm" onClick={() => setAddingContact(true)}>
                <Plus size={13} aria-hidden />
                {t('companies.addContact')}
              </Button>
            </div>
            {c.contacts.length === 0 ? (
              <p className="text-[13px] text-faint">{t('companies.noContacts')}</p>
            ) : (
              <ul className="divide-y divide-rule rounded-md border border-rule bg-raised">
                {c.contacts.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={`/contacts/${p.id}`}
                      className="grid grid-cols-[1fr_1fr_1.4fr] gap-4 px-3 py-2 text-[13px] hover:bg-sunken"
                    >
                      <span className="truncate font-medium">{p.displayName}</span>
                      <span className="truncate text-soft">{p.jobTitle ?? ''}</span>
                      <span className="truncate text-soft">{p.email ?? ''}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <ResearchSection companyId={c.id} hasWebsite={Boolean(c.domain || c.websiteUrl)} />
        <Timeline objectType="company" objectId={c.id} />
      </div>
      {editing ? <CompanyForm open company={c} onClose={() => setEditing(false)} /> : null}
      {addingContact ? (
        <ContactForm open company={{ id: c.id, name: c.name }} onClose={() => setAddingContact(false)} />
      ) : null}
    </>
  );
}
