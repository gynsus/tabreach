import type { ActiveWindow } from '@tabreach/protocol';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Input } from './ui';

/** ISO weekday (1 = Monday) → short name in the interface language. */
function weekdayName(day: number, language: string): string {
  // 2026-09-28 is a Monday.
  return new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 8, 27 + day)),
  );
}

/** Days and hours of an active window; times are wall-clock in each recipient's zone. */
export function WindowEditor(props: {
  value: ActiveWindow;
  onChange: (value: ActiveWindow) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { value, onChange } = props;
  const toggle = (day: number) => {
    const days = value.days.includes(day) ? value.days.filter((d) => d !== day) : [...value.days, day].sort();
    if (days.length > 0) onChange({ ...value, days });
  };
  const invalid = value.start >= value.end;
  return (
    <div className="grid gap-2">
      <div role="group" aria-label={t('campaigns.windowDays')} className="flex flex-wrap gap-1">
        {[1, 2, 3, 4, 5, 6, 7].map((day) => {
          const on = value.days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              disabled={props.disabled}
              onClick={() => toggle(day)}
              className={cn(
                'h-7 min-w-11 rounded-md border px-2 text-xs',
                on ? 'border-accent bg-accent-soft text-accent' : 'border-rule bg-raised text-soft',
              )}
            >
              {weekdayName(day, i18n.language)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        <label htmlFor={`${id}-from`} className="text-soft">
          {t('campaigns.windowFrom')}
        </label>
        <Input
          id={`${id}-from`}
          type="time"
          className="w-28"
          value={value.start}
          disabled={props.disabled}
          onChange={(e) => onChange({ ...value, start: e.target.value })}
        />
        <label htmlFor={`${id}-until`} className="text-soft">
          {t('campaigns.windowUntil')}
        </label>
        <Input
          id={`${id}-until`}
          type="time"
          className="w-28"
          value={value.end}
          aria-invalid={invalid ? true : undefined}
          disabled={props.disabled}
          onChange={(e) => onChange({ ...value, end: e.target.value })}
        />
      </div>
      <p className={cn('text-xs', invalid ? 'text-bad' : 'text-faint')}>
        {invalid ? t('errors.window.endBeforeStart') : t('campaigns.windowHint')}
      </p>
    </div>
  );
}
