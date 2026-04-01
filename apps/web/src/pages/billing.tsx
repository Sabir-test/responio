import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { billingApi } from '../lib/api-client';
import { useEffect } from 'react';

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 79,
    seats: 5,
    mac: 'Unlimited',
    features: ['WhatsApp + Web Chat', '5 agent seats', 'Basic reports'],
    highlight: false,
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 159,
    seats: 10,
    mac: '1,000 MACs',
    features: ['Everything in Starter', 'AI Agents', 'Workflows', 'Broadcasts', 'Advanced reports'],
    highlight: true,
  },
  {
    id: 'advanced',
    name: 'Advanced',
    price: 279,
    seats: 10,
    mac: '1,000 MACs',
    features: ['Everything in Growth', 'Voice AI', 'Multi-workspace', 'SSO', 'Custom channels'],
    highlight: false,
  },
];

export function BillingPage() {
  const [searchParams] = useSearchParams();
  const checkoutSuccess = searchParams.get('session_id');

  const { data: subscription, refetch } = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () => billingApi.getSubscription(),
  });

  const { data: usage } = useQuery({
    queryKey: ['billing', 'usage'],
    queryFn: () => billingApi.getUsage(),
  });

  useEffect(() => {
    if (checkoutSuccess) refetch();
  }, [checkoutSuccess, refetch]);

  const checkoutMutation = useMutation({
    mutationFn: ({ planId, interval }: { planId: string; interval: 'monthly' | 'annual' }) =>
      billingApi.createCheckout(planId, interval),
    onSuccess: (data) => {
      window.location.href = data.checkout_url;
    },
  });

  const portalMutation = useMutation({
    mutationFn: () => billingApi.openPortal(),
    onSuccess: (data) => {
      window.open(data.portal_url, '_blank');
    },
  });

  const sub = subscription?.data;
  const use = usage?.data;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your plan and usage.</p>
      </div>

      {checkoutSuccess && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 text-green-800 rounded-xl px-4 py-3 mb-6">
          <CheckCircle className="w-5 h-5 shrink-0" />
          <p className="text-sm font-medium">Subscription activated successfully!</p>
        </div>
      )}

      {/* Current plan summary */}
      {sub && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-8">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Current plan</p>
              <p className="text-lg font-bold text-gray-900">{sub.plan_name}</p>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${
                  sub.billing_status === 'active'
                    ? 'bg-green-100 text-green-700'
                    : sub.billing_status === 'trialing'
                    ? 'bg-blue-100 text-blue-700'
                    : sub.billing_status === 'past_due'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {sub.billing_status}
              </span>
            </div>

            <div className="text-right">
              {use && use.mac_limit && (
                <div className="mb-2">
                  <p className="text-xs text-gray-500">MAC usage this month</p>
                  <p className="text-sm font-semibold text-gray-900">
                    {use.mac_count.toLocaleString()} / {use.mac_limit.toLocaleString()}
                  </p>
                </div>
              )}
              {sub.stripe_subscription_id && (
                <button
                  onClick={() => portalMutation.mutate()}
                  disabled={portalMutation.isPending}
                  className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 font-medium"
                >
                  Manage billing <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {sub.billing_status === 'past_due' && (
            <div className="flex items-center gap-2 mt-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
              <p className="text-xs text-red-700">Payment failed. Please update your payment method to avoid service interruption.</p>
            </div>
          )}
        </div>
      )}

      {/* Plan selector */}
      <h2 className="text-base font-semibold text-gray-900 mb-4">Available Plans</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLANS.map((plan) => {
          const isCurrent = sub?.plan_id === plan.id;
          return (
            <div
              key={plan.id}
              className={`bg-white rounded-xl border p-5 flex flex-col ${
                plan.highlight ? 'border-brand-500 shadow-md' : 'border-gray-200'
              }`}
            >
              {plan.highlight && (
                <span className="self-start text-xs font-semibold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full mb-3">
                  Most Popular
                </span>
              )}
              <p className="font-bold text-gray-900 text-lg">{plan.name}</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                ${plan.price}
                <span className="text-sm font-normal text-gray-500">/mo</span>
              </p>
              <p className="text-xs text-gray-400 mt-0.5">{plan.seats} seats · {plan.mac}</p>

              <ul className="mt-4 mb-5 space-y-1.5 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-gray-600">
                    <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              <button
                disabled={isCurrent || checkoutMutation.isPending}
                onClick={() => checkoutMutation.mutate({ planId: plan.id, interval: 'monthly' })}
                className={`w-full py-2 rounded-lg text-sm font-medium transition-colors ${
                  isCurrent
                    ? 'bg-gray-100 text-gray-400 cursor-default'
                    : plan.highlight
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {isCurrent ? 'Current plan' : 'Upgrade'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
