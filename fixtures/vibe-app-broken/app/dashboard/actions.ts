'use server';

import { supabase } from '@/lib/supabase';

export async function updateProfile(formData: FormData) {
  const userId = formData.get('user_id') as string;
  const updates: any = Object.fromEntries(formData.entries());
  // TODO: validate input
  await supabase.from('profiles').update(updates).eq('id', userId);
}
