import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';

const ROW_HEIGHT = 44;
const PREFETCH_ROWS = 30;

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  /** CSS grid track per column, e.g. `minmax(200px,2fr)`. */
  tracks: string[];
  rows: T[];
  getRowId: (row: T) => string;
  rowHref: (row: T) => string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  label: string;
}

/**
 * Virtualized list table: renders only the visible rows and asks for the next page as the user
 * scrolls, so 10k prospects stay responsive (docs/21-TESTING.md performance target).
 */
export function DataTable<T>(props: DataTableProps<T>) {
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
  const { hasMore, loadingMore, onLoadMore } = props;

  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= rows.length - PREFETCH_ROWS) onLoadMore();
  }, [hasMore, loadingMore, lastIndex, rows.length, onLoadMore]);

  const grid = { gridTemplateColumns: props.tracks.join(' ') };
  return (
    <div
      role="table"
      aria-label={props.label}
      aria-rowcount={rows.length}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div role="rowgroup" className="border-b border-rule bg-paper px-6">
        {table.getHeaderGroups().map((group) => (
          <div key={group.id} role="row" className="grid gap-4 py-2" style={grid}>
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
            return (
              <Link
                key={row.id}
                role="row"
                to={props.rowHref(row.original)}
                aria-rowindex={item.index + 1}
                className="absolute top-0 left-0 grid w-full items-center gap-4 border-b border-rule px-6 text-[13px] hover:bg-raised focus-visible:bg-raised"
                style={{ ...grid, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div key={cell.id} role="cell" className="min-w-0 truncate">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
