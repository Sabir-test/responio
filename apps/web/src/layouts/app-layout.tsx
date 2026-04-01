import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Users,
  GitFork,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { AuthProvider, useAuth } from '../contexts/auth-context';
import { useEffect } from 'react';

const NAV_ITEMS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/conversations', icon: MessageSquare, label: 'Conversations' },
  { to: '/contacts', icon: Users, label: 'Contacts' },
  { to: '/workflows', icon: GitFork, label: 'Workflows' },
  { to: '/billing', icon: CreditCard, label: 'Billing' },
];

function SidebarNav() {
  const { user, logout, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) navigate('/auth/login', { replace: true });
  }, [isAuthenticated, navigate]);

  return (
    <aside className="flex flex-col w-56 shrink-0 bg-white border-r border-gray-200 h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5 border-b border-gray-100">
        <Zap className="w-6 h-6 text-brand-600" />
        <span className="font-bold text-gray-900 text-lg">Responio</span>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-2 py-4 space-y-0.5">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              )
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User footer */}
      <div className="border-t border-gray-100 px-3 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-900 truncate">{user?.email}</p>
            <p className="text-xs text-gray-400 capitalize">{user?.role}</p>
          </div>
          <button
            onClick={logout}
            className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

export function AppLayout() {
  return (
    <AuthProvider>
      <div className="flex min-h-screen bg-gray-50">
        <SidebarNav />
        <main className="flex-1 overflow-auto">
          <div className="max-w-7xl mx-auto px-6 py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </AuthProvider>
  );
}
