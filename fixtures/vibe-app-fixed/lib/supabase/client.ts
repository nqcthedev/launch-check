import { createBrowserClient } from '@supabase/ssr';

/** Browser client: anon key only. What it can touch is decided by RLS policies. */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
