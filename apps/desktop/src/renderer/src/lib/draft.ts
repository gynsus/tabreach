import { useState } from 'react';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An edit form's working copy of server data. A refresh from the server (after another save, or
 * a live update) replaces the copy only while it has no unsaved edits — it never discards them.
 */
export function useDraft<T>(server: T) {
  const [value, setValue] = useState(server);
  const [base, setBase] = useState(server);
  if (!same(server, base)) {
    setBase(server);
    if (same(value, base)) setValue(server);
  }
  return { value, setValue, dirty: !same(value, server), reset: () => setValue(server) };
}
