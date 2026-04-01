import { Outlet } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { AuthProvider } from '../contexts/auth-context';

export function AuthLayout() {
  return (
    <AuthProvider>
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center gap-2 mb-8">
            <Zap className="w-8 h-8 text-brand-600" />
            <span className="text-2xl font-bold text-gray-900">Responio</span>
          </div>
          <Outlet />
        </div>
      </div>
    </AuthProvider>
  );
}
