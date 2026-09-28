import { createColumnHelper } from '@tanstack/react-table';
import type { Company } from '@tabreach/protocol';
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
import { CompanyForm } from './CompanyForm';

const col = createColumnHelper<Company>();

export function CompaniesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { query, rows, total, searching } = usePagedList('companies.list', search);

  const columns = useMemo(
    () => [
      col.display({
        id: 'name',
        header: t('companies.name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      }),
      col.display({
        id: 'domain',
        header: t('companies.domain'),
        cell: ({ row }) => <span className="text-soft">{row.original.domain ?? ''}</span>,
      }),
      col.display({
        id: 'location',
        header: t('companies.city'),
        cell: ({ row }) => [row.original.city, row.original.country].filter(Boolean).join(', '),
      }),
      col.display({
        id: 'contacts',
        header: t('companies.contacts'),
        cell: ({ row }) => <span className="tabular-nums">{row.original.contactCount}</span>,
      }),
      col.display({
        id: 'tags',
        header: t('companies.tags'),
        cell: ({ row }) => <Tags tags={row.original.tags} />,
      }),
    ],
    [t],
  );

  return (
    <>
      <PageHeader
        title={t('companies.title')}
        subtitle={query.isSuccess ? t('common.total', { count: total }) : undefined}
        actions={
          <>
            <Input
              type="search"
              aria-label={t('companies.search')}
              placeholder={t('companies.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <ImportButton />
            <ExportButton />
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden />
              {t('companies.new')}
            </Button>
          </>
        }
      />
      {query.isError && !query.data ? (
        <div className="p-6">
          <Alert>{errorMessage(t, query.error)}</Alert>
        </div>
      ) : query.isSuccess && rows.length === 0 ? (
        searching ? (
          <EmptyState title={t('companies.noResults')} />
        ) : (
          <EmptyState
            title={t('companies.emptyTitle')}
            body={t('companies.emptyBody')}
            action={<ImportButton />}
          />
        )
      ) : (
        <DataTable
          label={t('companies.title')}
          columns={columns}
          tracks={[
            'minmax(180px,2fr)',
            'minmax(140px,1.5fr)',
            'minmax(120px,1.2fr)',
            '90px',
            'minmax(100px,1fr)',
          ]}
          rows={rows}
          total={total}
          getRowId={(c) => c.id}
          rowHref={(c) => `/companies/${c.id}`}
          hasMore={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          loadMoreFailed={query.isFetchNextPageError}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
      {creating ? (
        <CompanyForm
          open
          onClose={() => setCreating(false)}
          onSaved={(c) => navigate(`/companies/${c.id}`)}
        />
      ) : null}
    </>
  );
}
