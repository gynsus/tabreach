import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Navigate, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/toast';
import { setLanguage } from './i18n';
import { ActivityPage } from './routes/activity/ActivityPage';
import { ApprovalsPage } from './routes/approvals/ApprovalsPage';
import { InboxPage } from './routes/inbox/InboxPage';
import { CampaignPage } from './routes/campaigns/CampaignPage';
import { CampaignsPage } from './routes/campaigns/CampaignsPage';
import { CompaniesPage } from './routes/companies/CompaniesPage';
import { CompanyPage } from './routes/companies/CompanyPage';
import { ContactPage } from './routes/contacts/ContactPage';
import { ContactsPage } from './routes/contacts/ContactsPage';
import { SettingsPage } from './routes/settings/SettingsPage';
import { StatusPage } from './routes/status/StatusPage';
import { SuppressionsPage } from './routes/suppressions/SuppressionsPage';
import './styles.css';

// Hash routing: the packaged app loads from file://, where path-based URLs have no server behind them.
const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/contacts" replace /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'contacts/:id', element: <ContactPage /> },
      { path: 'companies', element: <CompaniesPage /> },
      { path: 'companies/:id', element: <CompanyPage /> },
      { path: 'suppressions', element: <SuppressionsPage /> },
      { path: 'campaigns', element: <CampaignsPage /> },
      { path: 'campaigns/:id', element: <CampaignPage /> },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'status', element: <StatusPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

/**
 * Applies the saved language before the first paint. If core is slow (first start, migrations),
 * the UI starts in English and switches as soon as the setting arrives.
 */
async function loadLanguage(): Promise<void> {
  const saved = window.tabreach.invoke('settings.ui.get', {});
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));
  const first = await Promise.race([saved, timeout]);
  if (first) {
    if (first.ok) await setLanguage(first.data.language);
    return;
  }
  void saved.then((late) => (late.ok ? setLanguage(late.data.language) : undefined));
}

const root = document.getElementById('root');
if (!root) throw new Error('#root element is missing from index.html');

void loadLanguage().finally(() => {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
