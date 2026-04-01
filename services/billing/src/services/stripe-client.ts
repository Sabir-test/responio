/**
 * Stripe client singleton.
 * All billing routes and webhook handlers share this instance.
 */

import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is not set');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  }
  return _stripe;
}

/**
 * Retrieve the Stripe customer for a tenant, creating one if it doesn't exist.
 */
export async function getOrCreateStripeCustomer(
  stripe: Stripe,
  tenantId: string,
  email: string,
  name: string,
  existingCustomerId?: string | null
): Promise<string> {
  if (existingCustomerId) {
    return existingCustomerId;
  }

  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { tenant_id: tenantId },
  });

  return customer.id;
}
