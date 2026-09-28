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

/** Searchable company combobox (ARIA combobox pattern): type to search, arrows + Enter to pick. */
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
    queryFn: () => call('companies.list', { search: text || undefined, limit: 20, offset: 0 }),
    enabled: open,
  });
  const options: (PickedCompany | null)[] = [
    null,
    ...(query.data?.items ?? []).map((c) => ({ id: c.id, name: c.name })),
  ];

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
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        value={text}
        placeholder={t('contacts.noCompany')}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
          if (!e.target.value) props.onChange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            pick(options[active] ?? null);
          } else if (e.key === 'Escape') {
            setOpen(false);
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
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(option);
              }}
              className={cn(
                'cursor-pointer px-2.5 py-1.5 text-[13px]',
                i === active && 'bg-accent-soft',
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
