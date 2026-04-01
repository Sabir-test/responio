import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Users, GitFork, TrendingUp } from 'lucide-react';
import { billingApi } from '../lib/api-client';
import { useAuth } from '../contexts/auth-context';

export function DashboardPage() {
  const { user } = useAuth();

  const { data: subscription } = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () => billingApi.getSubscription(),
  });

  const { data: usage } = useQuery({
    queryKey: ['billing', 'usage'],
    queryFn: () => billingApi.getUsage(),
  });

  const sub = subscription?.data;
  const use = usage?.data;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Welcome back{user?.email ? `, ${user.email}` : ''}.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          icon={<MessageSquare className="w-5 h-5 text-blue-600" />}
          label="Open Conversations"
          value="—"
          bg="bg-blue-50"
        />
        <StatCard
          icon={<Users className="w-5 h-5 text-green-600" />}
          label="Active Contacts (MAC)"
          value={use?.mac_count ?? '—'}
          sub={use?.mac_limit ? `of ${use.mac_limit} limit` : undefined}
          bg="bg-green-50"
        />
        <StatCard
          icon={<GitFork className="w-5 h-5 text-purple-600" />}
          label="Active Workflows"
          value="—"
          bg="bg-purple-50"
        />
        <StatCard
          icon={<TrendingUp className="w-5 h-5 text-orange-600" />}
          label="Plan"
          value={sub?.plan_name ?? '—'}
          sub={sub?.billing_status}
          bg="bg-orange-50"
        />
      </div>

      {/* MAC Usage Bar */}
      {use && use.mac_limit && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-medium text-gray-700">Monthly Active Contacts</h2>
            <span className="text-sm text-gray-500">
              {use.mac_count} / {use.mac_limit}
            </span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                (use.usage_pct ?? 0) >= 100
                  ? 'bg-red-500'
                  : (use.usage_pct ?? 0) >= 80
                  ? 'bg-amber-500'
                  : 'bg-brand-500'
              }`}
              style={{ width: `${Math.min(use.usage_pct ?? 0, 100)}%` }}
            />
          </div>
          {(use.usage_pct ?? 0) >= 80 && (
            <p className="text-xs text-amber-600 mt-2">
              You've used {use.usage_pct}% of your MAC limit.{' '}
              {use.projected_overage_usd > 0 && `Projected overage: $${use.projected_overage_usd}`}
            </p>
          )}
        </div>
      )}

      {/* Placeholder for inbox service stats */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Recent Conversations</h2>
        <p className="text-sm text-gray-400">
          Conversation inbox coming soon — Chatwoot fork integration in progress.
        </p>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  bg,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  bg: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className={`inline-flex p-2 rounded-lg ${bg} mb-3`}>{icon}</div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
      {sub && <p className="text-xs text-gray-400 capitalize">{sub}</p>}
    </div>
  );
}
