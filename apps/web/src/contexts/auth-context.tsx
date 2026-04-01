import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { setToken, clearToken } from '../lib/api-client';

interface AuthUser {
  sub: string;
  tenant_id: string;
  email: string;
  role: 'owner' | 'admin' | 'agent';
  workspace_ids: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function parseJwt(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      sub: payload.sub,
      tenant_id: payload.tenant_id,
      email: payload.email,
      role: payload.role,
      workspace_ids: payload.workspace_ids ?? [],
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const stored = localStorage.getItem('responio_token');
    return stored ? parseJwt(stored) : null;
  });

  const login = useCallback((token: string) => {
    setToken(token);
    setUser(parseJwt(token));
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  // Auto-logout on token expiry
  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('responio_token');
    if (!token) return;
    const payload = JSON.parse(atob(token.split('.')[1]));
    const expiresIn = payload.exp * 1000 - Date.now();
    if (expiresIn <= 0) { logout(); return; }
    const timer = setTimeout(logout, expiresIn);
    return () => clearTimeout(timer);
  }, [user, logout]);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
