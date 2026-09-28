import { createColumnHelper } from '@tanstack/react-table';
import type { Contact } from '@tabreach/protocol';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { DataTable } from '../../components/DataTable';
import { Alert, Button, EmptyState, Input, PageHeader, Tags } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { usePagedList } from '../../lib/lists';
import { ExportButton } from '../imports/ExportButton';
import { ImportButton } from '../imports/ImportDialog';
import { ContactForm } from './ContactForm';

const col = createColumnHelper<Contact>();

export function ContactsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { query, rows, total, searching } = usePagedList('contacts.list', search);

  const columns = useMemo(
    () => [
      col.display({
        id: 'name',
        header: t('contacts.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.displayName}</span>,
      }),
      col.display({
        id: 'company',
        header: t('contacts.company'),
        cell: ({ row }) => row.original.companyName ?? '',
      }),
      col.display({
        id: 'title',
        header: t('contacts.jobTitle'),
        cell: ({ row }) => row.original.jobTitle ?? '',
      }),
      col.display({
        id: 'email',
        header: t('contacts.email'),
        cell: ({ row }) => <span className="text-soft">{row.original.email ?? ''}</span>,
      }),
      col.display({
        id: 'tags',
        header: t('contacts.tags'),
        cell: ({ row }) => <Tags tags={row.original.tags} />,
      }),
    ],
    [t],
  );

  return (
    <>
      <PageHeader
        title={t('contacts.title')}
        subtitle={query.isSuccess ? t('common.total', { count: total }) : undefined}
        actions={
          <>
            <Input
              type="search"
              aria-label={t('contacts.search')}
              placeholder={t('contacts.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-72"
            />
            <ImportButton />
            <ExportButton />
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden />
              {t('contacts.new')}
            </Button>
          </>
        }
      />
      {query.isError ? (
        <div className="p-6">
          <Alert>{errorMessage(t, query.error)}</Alert>
        </div>
      ) : query.isSuccess && rows.length === 0 ? (
        searching ? (
          <EmptyState title={t('contacts.noResults')} />
        ) : (
          <EmptyState
            title={t('contacts.emptyTitle')}
            body={t('contacts.emptyBody')}
            action={<ImportButton />}
          />
        )
      ) : (
        <DataTable
          label={t('contacts.title')}
          columns={columns}
          tracks={[
            'minmax(160px,2fr)',
            'minmax(120px,1.5fr)',
            'minmax(120px,1.5fr)',
            'minmax(160px,2fr)',
            'minmax(100px,1fr)',
          ]}
          rows={rows}
          getRowId={(c) => c.id}
          rowHref={(c) => `/contacts/${c.id}`}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
      {creating ? (
        <ContactForm open onClose={() => setCreating(false)} onSaved={(c) => navigate(`/contacts/${c.id}`)} />
      ) : null}
    </>
  );
}
