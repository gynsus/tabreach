import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Button } from './ui';

const ROW_HEIGHT = 44;
const PREFETCH_ROWS = 30;

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  /** CSS grid track per column, e.g. `minmax(200px,2fr)`. */
  tracks: string[];
  rows: T[];
  /** Total rows on the server (for assistive tech), not only the loaded ones. */
  total: number;
  getRowId: (row: T) => string;
  rowHref: (row: T) => string;
  hasMore: boolean;
  loadingMore: boolean;
  /** Loading the next page failed: rows already shown stay, with a retry below them. */
  loadMoreFailed: boolean;
  onLoadMore: () => void;
  label: string;
}

/**
 * Virtualized list table: renders only the visible rows and asks for the next page as the user
 * scrolls, so 10k prospects stay responsive (docs/21-TESTING.md performance target). The first
 * cell of each row is the link (keyboard and screen readers); the whole row is clickable.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const table = useReactTable({
    data: props.rows,
    columns: props.columns,
    getRowId: props.getRowId,
    getCoreRowModel: getCoreRowModel(),
  });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? 0;
  const { hasMore, loadingMore, loadMoreFailed, onLoadMore } = props;

  useEffect(() => {
    if (hasMore && !loadingMore && !loadMoreFailed && lastIndex >= rows.length - PREFETCH_ROWS) onLoadMore();
  }, [hasMore, loadingMore, loadMoreFailed, lastIndex, rows.length, onLoadMore]);

  const grid = { gridTemplateColumns: props.tracks.join(' ') };
  return (
    <div
      role="table"
      aria-label={props.label}
      aria-rowcount={props.total + 1}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div role="rowgroup" className="border-b border-rule bg-paper px-6">
        {table.getHeaderGroups().map((group) => (
          <div key={group.id} role="row" aria-rowindex={1} className="grid gap-4 py-2" style={grid}>
            {group.headers.map((header) => (
              <div key={header.id} role="columnheader" className="text-xs font-medium text-soft">
                {flexRender(header.column.columnDef.header, header.getContext())}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div ref={scrollRef} role="rowgroup" className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const href = props.rowHref(row.original);
            return (
              <div
                key={row.id}
                role="row"
                aria-rowindex={item.index + 2}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('a')) navigate(href);
                }}
                className="absolute top-0 left-0 grid w-full cursor-pointer items-center gap-4 border-b border-rule px-6 text-[13px] hover:bg-raised"
                style={{ ...grid, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                {row.getVisibleCells().map((cell, i) => (
                  <div key={cell.id} role="cell" className="min-w-0 truncate">
                    {i === 0 ? (
                      <Link to={href} className="outline-offset-2 hover:underline">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Link>
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {loadMoreFailed ? (
          <div className="flex items-center gap-3 px-6 py-3 text-[13px] text-bad" role="alert">
            {t('errors.generic')}
            <Button size="sm" onClick={onLoadMore}>
              {t('common.retry')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
