import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ChangedEntity, CoreState } from '@tabreach/protocol';
import { useEffect, useRef, useState } from 'react';

/** Query-key prefixes that show each kind of data (see the useQuery calls in routes/ and components/). */
const KEYS: Record<ChangedEntity, string[]> = {
  company: ['companies.list', 'company', 'companies'],
  contact: ['contacts.list', 'contact', 'company'],
  suppression: ['suppressions.list'],
  activity: ['activity'],
  settings: ['settings'],
  job: ['jobs'],
  campaign: ['campaigns', 'campaign'],
  enrollment: ['enrollments', 'campaigns', 'campaign'],
  approval: ['approvals', 'campaigns', 'campaign'],
  account: ['accounts'],
};

/** Refetches only the queries that show the changed data (not every loaded page of every list). */
export function invalidateEntities(qc: QueryClient, entities: readonly ChangedEntity[]): Promise<void> {
  const prefixes = new Set(entities.flatMap((e) => KEYS[e]));
  return qc.invalidateQueries({ predicate: (q) => prefixes.has(String(q.queryKey[0])) });
}

/**
 * Keeps the UI in sync with core (ADR 020): `data.changed` events refetch affected queries, and
 * when core comes back after a restart everything is refetched, because events may have been lost.
 */
export function useLiveUpdates(): CoreState {
  const qc = useQueryClient();
  const [state, setState] = useState<CoreState>('starting');
  const wasDown = useRef(false);

  useEffect(() => {
    const offEvents = window.tabreach.subscribe('data.changed', ({ entities }) => {
      void invalidateEntities(qc, entities);
    });
    const offState = window.tabreach.onCoreState((next) => {
      setState(next);
      if (next === 'running' && wasDown.current) void qc.invalidateQueries();
      wasDown.current = next !== 'running';
    });
    return () => {
      offEvents();
      offState();
    };
  }, [qc]);

  return state;
}
