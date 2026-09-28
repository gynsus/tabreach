import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Navigate, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/toast';
import { setLanguage } from './i18n';
import { ActivityPage } from './routes/activity/ActivityPage';
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
      { path: 'activity', element: <ActivityPage /> },
      { path: 'status', element: <StatusPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

/** Applies the saved language before the first paint; English if core is not reachable in time. */
async function loadLanguage(): Promise<void> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000));
  const result = await Promise.race([window.tabreach.invoke('settings.ui.get', {}), timeout]);
  await setLanguage(result?.ok ? result.data.language : 'en');
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
