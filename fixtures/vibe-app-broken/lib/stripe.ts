import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_live_DUMMY-launch-check-fixture-not-a-real-key', {
  apiVersion: '2023-10-16',
});

export async function createCheckout(userId: string) {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: 'price_pro_monthly', quantity: 1 }],
    success_url: `${window.location.origin}/dashboard?upgraded=1`,
    cancel_url: `${window.location.origin}/dashboard`,
    metadata: { userId },
  });
  return session.url;
}
