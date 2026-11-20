import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { requireUser } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return NextResponse.json({ error: 'Checkout is not configured' }, { status: 500 });

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/dashboard?upgraded=1`,
    cancel_url: `${origin}/dashboard`,
    // The user id comes from the verified session, not from the request body.
    client_reference_id: user.id,
  });
  return NextResponse.json({ url: session.url });
}
