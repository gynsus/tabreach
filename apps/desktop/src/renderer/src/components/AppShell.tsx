import {
  Activity,
  Building2,
  CheckCheck,
  Gauge,
  Globe,
  Inbox,
  Megaphone,
  Settings,
  ShieldBan,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { useLiveUpdates } from '../lib/live';
import { cn } from '../lib/cn';
import { usePendingApprovals } from '../routes/approvals/ApprovalsPage';
import { useInboxCounts } from '../routes/inbox/InboxPage';
import { PausedBanner } from '../routes/status/AppControl';
import { useInterventions } from '../routes/status/Interventions';

function NavItem(props: { to: string; icon: LucideIcon; label: string; count?: number }) {
  const Icon = props.icon;
  return (
    <NavLink
      to={props.to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-soft hover:bg-sunken hover:text-ink',
          isActive && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft hover:text-accent',
        )
      }
    >
      <Icon size={15} aria-hidden />
      {props.label}
      {props.count ? (
        <span className="ml-auto rounded bg-accent px-1.5 font-mono text-[10px] leading-4 text-accent-ink">
          {props.count}
        </span>
      ) : null}
    </NavLink>
  );
}

function NavGroup(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <p className="px-2.5 pb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {props.label}
      </p>
      {props.children}
    </div>
  );
}

/** Says plainly when core cannot answer, instead of letting every request wait for a timeout. */
function CoreBanner() {
  const { t } = useTranslation();
  const state = useLiveUpdates();
  if (state === 'running') return null;
  return (
    <p
      role={state === 'failed' ? 'alert' : 'status'}
      data-testid="core-banner"
      data-state={state}
      className={cn(
        'px-6 py-2 text-[13px]',
        state === 'failed' ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn',
      )}
    >
      {t(`core.${state}`)}
    </p>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const pending = usePendingApprovals();
  const inbox = useInboxCounts();
  const interventions = useInterventions();
  return (
    <div className="flex h-full">
      <nav
        aria-label="TabReach"
        className="relative flex w-56 shrink-0 flex-col gap-5 border-r border-rule bg-sunken px-3 pt-5 pb-4"
      >
        <p className="px-2.5 font-mono text-[11px] font-medium tracking-[0.14em] text-accent uppercase">
          TabReach
        </p>
        <NavGroup label={t('nav.prospects')}>
          <NavItem to="/contacts" icon={Users} label={t('nav.contacts')} />
          <NavItem to="/companies" icon={Building2} label={t('nav.companies')} />
          <NavItem to="/suppressions" icon={ShieldBan} label={t('nav.suppressions')} />
        </NavGroup>
        <NavGroup label={t('nav.outreach')}>
          <NavItem to="/campaigns" icon={Megaphone} label={t('nav.campaigns')} />
          <NavItem to="/inbox" icon={Inbox} label={t('nav.inbox')} count={inbox.data?.unread ?? 0} />
          <NavItem
            to="/approvals"
            icon={CheckCheck}
            label={t('nav.approvals')}
            count={pending.data?.items.length ?? 0}
          />
          <NavItem to="/activity" icon={Activity} label={t('nav.activity')} />
        </NavGroup>
        <div className="mt-auto">
          <NavGroup label={t('nav.system')}>
            <NavItem to="/browser" icon={Globe} label={t('nav.browser')} />
            <NavItem
              to="/status"
              icon={Gauge}
              label={t('nav.status')}
              count={interventions.data?.items.length ?? 0}
            />
            <NavItem to="/settings" icon={Settings} label={t('nav.settings')} />
          </NavGroup>
        </div>
      </nav>
      {/*
        Positioned, so absolutely placed content (screen-reader-only labels, popovers) is laid out
        and clipped here: otherwise it stretches the window and the whole app scrolls.
      */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <CoreBanner />
        <PausedBanner />
        <Outlet />
      </main>
    </div>
  );
}
