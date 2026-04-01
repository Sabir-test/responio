import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layouts/app-layout';
import { AuthLayout } from './layouts/auth-layout';
import { LoginPage } from './pages/login';
import { DashboardPage } from './pages/dashboard';
import { ConversationsPage } from './pages/conversations';
import { ContactsPage } from './pages/contacts';
import { WorkflowsPage } from './pages/workflows';
import { BillingPage } from './pages/billing';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'conversations', element: <ConversationsPage /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      { path: 'billing', element: <BillingPage /> },
      { path: 'billing/success', element: <BillingPage /> },
    ],
  },
  {
    path: '/auth',
    element: <AuthLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);
