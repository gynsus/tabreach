import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call } from '../lib/api';
import { cn } from '../lib/cn';
import { Input } from './ui';

export interface PickedCompany {
  id: string;
  name: string;
}

/**
 * Searchable company combobox (ARIA combobox pattern). Typing searches; Enter picks the highlighted
 * match (the first one by default). The input never shows a company that is not actually selected:
 * leaving the field without picking restores the current selection.
 */
export function CompanyPicker(props: {
  id: string;
  value: PickedCompany | null;
  onChange: (company: PickedCompany | null) => void;
  describedBy?: string | undefined;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [text, setText] = useState(props.value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = useQuery({
    queryKey: ['companies', 'picker', text],
    queryFn: () => call('companies.list', { search: text.trim() || undefined, limit: 20, offset: 0 }),
    enabled: open,
  });
  const matches: PickedCompany[] = (query.data?.items ?? []).map((c) => ({ id: c.id, name: c.name }));
  // With a search, matches come first so Enter picks one; with an empty field, "No company" does.
  const options: (PickedCompany | null)[] = text.trim() ? [...matches, null] : [null, ...matches];
  const current = Math.min(active, options.length - 1);

  const pick = (company: PickedCompany | null) => {
    props.onChange(company);
    setText(company?.name ?? '');
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        id={props.id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={props.describedBy}
        aria-activedescendant={open && options.length > 0 ? `${listId}-${current}` : undefined}
        value={text}
        placeholder={t('contacts.noCompany')}
        onFocus={() => setOpen(true)}
        onBlur={() =>
          setTimeout(() => {
            setOpen(false);
            setText(props.value?.name ?? '');
          }, 150)
        }
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive(Math.min(current + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(Math.max(current - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            pick(options[current] ?? null);
          } else if (e.key === 'Escape' && open) {
            // Closes the list only, not the dialog around it (audit 4.5).
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setText(props.value?.name ?? '');
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-rule bg-raised py-1 shadow-lg"
        >
          {options.map((option, i) => (
            <li
              key={option?.id ?? 'none'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(option);
              }}
              className={cn(
                'cursor-pointer px-2.5 py-1.5 text-[13px]',
                i === current && 'bg-accent-soft',
                !option && 'text-soft',
              )}
            >
              {option?.name ?? t('contacts.noCompany')}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
