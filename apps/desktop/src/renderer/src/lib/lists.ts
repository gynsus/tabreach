import { useInfiniteQuery } from '@tanstack/react-query';
import type { Company, Contact, RequestOf, ResponseOf, Suppression } from '@tabreach/protocol';
import { useDeferredValue } from 'react';
import { call, PAGE_SIZE } from './api';

type ListType = 'companies.list' | 'contacts.list' | 'suppressions.list';
type Item<T extends ListType> = T extends 'companies.list'
  ? Company
  : T extends 'contacts.list'
    ? Contact
    : Suppression;

/** Server-paged list with search; pages load as the table scrolls. */
export function usePagedList<T extends ListType>(type: T, search: string) {
  const deferred = useDeferredValue(search.trim());
  const query = useInfiniteQuery({
    queryKey: [type, deferred],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      call(type, { search: deferred || undefined, limit: PAGE_SIZE, offset: pageParam } as RequestOf<T>),
    getNextPageParam: (last: ResponseOf<T>, pages: ResponseOf<T>[]) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const pages: ResponseOf<T>[] = query.data?.pages ?? [];
  return {
    query,
    rows: pages.flatMap((p) => p.items as Item<T>[]),
    total: pages[0]?.total ?? 0,
    searching: deferred.length > 0,
  };
}
