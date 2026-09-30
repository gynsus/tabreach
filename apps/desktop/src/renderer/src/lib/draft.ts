import { useState } from 'react';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An edit form's working copy of server data.
 *
 * - `dirty` compares with the last saved copy: what came from the server, or what was just saved.
 * - `saved()` marks the current copy as saved at once. The server's answer may differ in form
 *   (a timestamp it set, trimmed text, a normalized value); when that copy arrives it replaces
 *   the form's copy, so a saved form never stays "unsaved".
 * - A refresh from the server replaces the copy only while it has no unsaved edits — it never
 *   discards them.
 */
export function useDraft<T>(server: T) {
  const [value, setValue] = useState(server);
  const [base, setBase] = useState(server);
  const [seen, setSeen] = useState(server);
  if (!same(server, seen)) {
    setSeen(server);
    setBase(server);
    if (same(value, base)) setValue(server);
  }
  return {
    value,
    setValue,
    dirty: !same(value, base),
    reset: () => setValue(base),
    saved: () => setBase(value),
  };
}
