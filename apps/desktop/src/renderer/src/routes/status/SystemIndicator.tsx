import { useQuery } from '@tanstack/react-query';
import type { HealthReport } from '@tabreach/protocol';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { call } from '../../lib/api';
import { AppControlButtons, useAppControl } from './AppControl';
import { useInterventions } from './Interventions';

const REFRESH_MS = 30_000;

export const DOT = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', neutral: 'bg-faint' } as const;

type Tone = keyof typeof DOT;

/** The parts that must work for anything to be sent, in the order a problem is named. */
type Part = 'core' | 'database' | 'secrets' | 'worker' | 'chrome';

function brokenPart(h: HealthReport): { part: Part; tone: Tone } | null {
  const worker = h.worker;
  const chrome = 'chrome' in worker ? worker.chrome : null;
  const parts: [Part, string][] = [
    ['core', h.core.status],
    ['database', h.database.status],
    ['secrets', h.secrets.status],
    ['worker', 'chrome' in worker ? 'ok' : worker.status],
    ['chrome', chrome ? (chrome.installed ? 'ok' : 'down') : 'unknown'],
  ];
  const down = parts.find(([, s]) => s === 'down');
  if (down) return { part: down[0], tone: 'bad' };
  const degraded = parts.find(([, s]) => s === 'degraded');
  return degraded ? { part: degraded[0], tone: 'warn' } : null;
}

/**
 * One line about the whole app (docs/22 9a), for the menu and Today: paused, a broken part, things
 * waiting under Needs attention, or all fine. `attention` counts browser windows waiting for the
 * user, uncertain sends and failed background jobs.
 */
export function useSystemSummary(): { tone: Tone; text: string; attention: number } {
  const { t } = useTranslation();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => call('app.health', {}),
    refetchInterval: REFRESH_MS,
  });
  const control = useAppControl();
  const interventions = useInterventions();
  const uncertain = useQuery({
    queryKey: ['jobs', 'uncertain'],
    queryFn: () => call('sideEffects.uncertain', {}),
  });
  const jobs = useQuery({ queryKey: ['jobs', 'attention'], queryFn: () => call('jobs.needsAttention', {}) });
  const attention =
    (interventions.data?.items.length ?? 0) +
    (uncertain.data?.items.length ?? 0) +
    (jobs.data?.items.length ?? 0);

  if (control.data?.emergencyStoppedAt) return { tone: 'bad', text: t('system.emergencyStopped'), attention };
  if (control.data?.paused) return { tone: 'warn', text: t('system.paused'), attention };
  if (health.isError) return { tone: 'bad', text: t('system.noAnswer'), attention };
  const broken = health.data ? brokenPart(health.data) : null;
  if (broken) return { tone: broken.tone, text: t(`system.broken.${broken.part}`), attention };
  if (attention) return { tone: 'warn', text: t('system.attention', { count: attention }), attention };
  if (!health.data) return { tone: 'neutral', text: t('system.checking'), attention };
  return { tone: 'ok', text: t('system.ok'), attention };
}

/**
 * The status line at the foot of the menu. A click opens Pause all, Emergency stop and a link to the
 * full Status page, so stopping is one step away from any screen.
 */
export function SystemIndicator() {
  const { t } = useTranslation();
  const summary = useSystemSummary();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="system-indicator"
        data-tone={summary.tone}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-soft hover:bg-raised hover:text-ink"
      >
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[summary.tone])} />
        <span className="min-w-0 flex-1 truncate">{summary.text}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('system.title')}
          className="absolute bottom-full left-0 z-20 mb-2 grid w-72 gap-3 rounded-md border border-rule bg-raised p-4 text-[13px] shadow-xl"
        >
          <p className="flex items-center gap-2 font-medium">
            <span aria-hidden className={cn('size-2 rounded-full', DOT[summary.tone])} />
            {summary.text}
          </p>
          <AppControlButtons />
          <Link to="/status" onClick={() => setOpen(false)} className="text-accent hover:underline">
            {t('system.details')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
