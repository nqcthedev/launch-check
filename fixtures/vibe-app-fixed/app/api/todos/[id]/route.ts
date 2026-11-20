import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/supabase/server';

const Params = z.object({ id: z.coerce.number().int().positive() });

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = Params.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  // RLS already limits this to the caller's rows; the user_id filter makes the intent explicit.
  const { error, count } = await supabase
    .from('todos')
    .delete({ count: 'exact' })
    .eq('id', parsed.data.id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: 'Could not delete todo' }, { status: 500 });
  if (count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ success: true });
}
