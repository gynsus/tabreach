import { cn } from '../lib/cn';

/**
 * A row of tabs (WAI-ARIA tabs pattern): arrow keys move between them. The panel is the caller's,
 * with `id={`${idPrefix}-panel-${current}`}` and `aria-labelledby={`${idPrefix}-tab-${current}`}`.
 */
export function Tabs<T extends string>(props: {
  label: string;
  idPrefix: string;
  tabs: readonly { id: T; label: string; marked?: boolean }[];
  /** Read out with a marked tab (for example "has errors"). */
  markedLabel?: string;
  current: T;
  onSelect: (id: T) => void;
}) {
  const ids = props.tabs.map((tab) => tab.id);
  return (
    <div role="tablist" aria-label={props.label} className="flex gap-1 border-b border-rule px-6">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          id={`${props.idPrefix}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={props.current === tab.id}
          aria-controls={`${props.idPrefix}-panel-${tab.id}`}
          tabIndex={props.current === tab.id ? 0 : -1}
          onClick={() => props.onSelect(tab.id)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = ids[(ids.indexOf(props.current) + step + ids.length) % ids.length]!;
            props.onSelect(next);
            requestAnimationFrame(() => document.getElementById(`${props.idPrefix}-tab-${next}`)?.focus());
          }}
          className={cn(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px]',
            props.current === tab.id
              ? 'border-accent font-medium text-accent'
              : 'border-transparent text-soft hover:text-ink',
          )}
        >
          {tab.label}
          {tab.marked ? (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-bad" />
              {props.markedLabel ? <span className="sr-only">{props.markedLabel}</span> : null}
            </>
          ) : null}
        </button>
      ))}
    </div>
  );
}
