import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  const event = await req.json();

  if (event.type === 'checkout.session.completed') {
    const userId = event.data.object.metadata.userId;
    await supabase.from('profiles').update({ plan: 'pro', credits: 1000 }).eq('id', userId);
  }

  return NextResponse.json({ received: true });
}
