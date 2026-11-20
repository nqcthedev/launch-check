'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/supabase/server';

const TodoInput = z.object({ title: z.string().trim().min(1).max(200) });
const ProfileInput = z.object({ full_name: z.string().trim().min(1).max(100) });

export async function addTodo(formData: FormData) {
  const { supabase, user } = await requireUser();
  if (!user) throw new Error('Unauthorized');

  const input = TodoInput.parse({ title: formData.get('title') });
  const { error } = await supabase.from('todos').insert({ title: input.title, user_id: user.id });
  if (error) throw new Error('Could not add todo');
  revalidatePath('/dashboard');
}

export async function updateProfile(formData: FormData) {
  const { supabase, user } = await requireUser();
  if (!user) throw new Error('Unauthorized');

  // Whitelist the editable column: the user id comes from the session, never from the form,
  // and plan/credits cannot be set by the client (see the lock_down_rls migration).
  const input = ProfileInput.parse({ full_name: formData.get('full_name') });
  const { error } = await supabase.from('profiles').update({ full_name: input.full_name }).eq('id', user.id);
  if (error) throw new Error('Could not update profile');
  revalidatePath('/dashboard');
}
