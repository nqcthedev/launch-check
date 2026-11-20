import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Service-role client: bypasses RLS. Only for trusted server code that has already
 * verified the caller (e.g. a signed Stripe webhook). Never import from a client component.
 */
export function createAdminClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
