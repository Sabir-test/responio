/**
 * Responio pricing plan definitions.
 * Source of truth for plan features, limits, and Stripe price IDs.
 */

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    monthly_price_usd: 79,
    annual_price_usd: 948, // 20% off
    included_seats: 5,
    additional_seat_price_usd: 12,
    mac_limit: null, // Unlimited contacts (but no AI/workflows)
    features: {
      ai_agents: false,
      workflows: false,
      broadcasts: false,
      voice_ai: false,
      multi_workspace: false,
      sso: false,
      http_in_workflows: false,
      custom_channels: false,
      advanced_reports: false,
    },
    stripe_price_ids: {
      monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY ?? '',
      annual: process.env.STRIPE_PRICE_STARTER_ANNUAL ?? '',
      seat_addon: process.env.STRIPE_PRICE_SEAT_ADDON_STARTER ?? '',
    },
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    monthly_price_usd: 159,
    annual_price_usd: 1_908,
    included_seats: 10,
    additional_seat_price_usd: 20,
    mac_limit: 1_000, // Base, overage charged
    mac_overage_price_usd: 12, // Per 100 MACs
    features: {
      ai_agents: true,
      workflows: true,
      broadcasts: true,
      voice_ai: false,
      multi_workspace: false,
      sso: false,
      http_in_workflows: false,
      custom_channels: false,
      advanced_reports: true,
    },
    stripe_price_ids: {
      monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY ?? '',
      annual: process.env.STRIPE_PRICE_GROWTH_ANNUAL ?? '',
      seat_addon: process.env.STRIPE_PRICE_SEAT_ADDON_GROWTH ?? '',
    },
  },
  advanced: {
    id: 'advanced',
    name: 'Advanced',
    monthly_price_usd: 279,
    annual_price_usd: 3_348,
    included_seats: 10,
    additional_seat_price_usd: 24,
    mac_limit: 1_000,
    mac_overage_price_usd: 15, // Per 100 MACs
    features: {
      ai_agents: true,
      workflows: true,
      broadcasts: true,
      voice_ai: true,
      multi_workspace: true,
      sso: true,
      http_in_workflows: true,
      custom_channels: true,
      advanced_reports: true,
    },
    stripe_price_ids: {
      monthly: process.env.STRIPE_PRICE_ADVANCED_MONTHLY ?? '',
      annual: process.env.STRIPE_PRICE_ADVANCED_ANNUAL ?? '',
      seat_addon: process.env.STRIPE_PRICE_SEAT_ADDON_ADVANCED ?? '',
    },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthly_price_usd: null, // Custom pricing
    annual_price_usd: null,
    included_seats: null, // Unlimited
    additional_seat_price_usd: null,
    mac_limit: null, // Custom
    mac_overage_price_usd: null, // Custom
    features: {
      ai_agents: true,
      workflows: true,
      broadcasts: true,
      voice_ai: true,
      multi_workspace: true,
      sso: true,
      http_in_workflows: true,
      custom_channels: true,
      advanced_reports: true,
    },
    stripe_price_ids: {
      monthly: null,
      annual: null,
      seat_addon: null,
    },
  },
} as const;

export type PlanId = keyof typeof PLANS;
export type Plan = (typeof PLANS)[PlanId];
export type PlanFeatures = Plan['features'];

export function getPlan(planId: string): Plan | null {
  return (PLANS as Record<string, Plan>)[planId] ?? null;
}

export function hasFeature(planId: PlanId, feature: keyof PlanFeatures): boolean {
  return PLANS[planId].features[feature] as boolean;
}

/**
 * MAC overage calculation.
 * Billed at the end of the billing cycle in 100-MAC increments.
 */
export function calculateMacOverage(
  planId: PlanId,
  currentMac: number
): { overage_units: number; overage_amount_usd: number } | null {
  const plan = PLANS[planId];

  if (!plan.mac_limit || !plan.mac_overage_price_usd) return null;
  if (currentMac <= plan.mac_limit) return null;

  const overage = currentMac - plan.mac_limit;
  const overage_units = Math.ceil(overage / 100);
  const overage_amount_usd = overage_units * plan.mac_overage_price_usd;

  return { overage_units, overage_amount_usd };
}
