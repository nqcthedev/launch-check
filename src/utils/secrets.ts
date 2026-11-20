/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Show enough of a secret to identify it, never enough to use it. */
export function redact(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  const keep = Math.min(8, Math.floor(value.length / 4));
  return `${value.slice(0, keep)}${'*'.repeat(6)}${value.length > 24 ? `…(${value.length} chars)` : ''}`;
}

/** Replace every occurrence of `secret` in `line` with its redacted form. */
export function redactInLine(line: string, secret: string): string {
  return line.split(secret).join(redact(secret));
}

const PLACEHOLDER_RE =
  /(your[_-]?|<|>|\{\{|xxxx|\.\.\.|changeme|change[_-]me|replace[_-]?me|placeholder|example|sample|dummy[_-]?value|insert[_-]|\*\*\*\*|^test$|^secret$|^password$|^null$|^undefined$)/i;

/** Values like "your-api-key-here", "sk_live_xxx", "<SECRET>" are documentation, not secrets. */
export function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER_RE.test(value)) return true;
  // Long runs of the same char ("aaaaaaaa", "00000000") with nothing else.
  if (/^(.)\1+$/.test(value.replace(/^[a-z]{2,4}_(live|test)_/i, ''))) return true;
  return false;
}

export interface JwtInfo {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function b64urlDecode(part: string): string | null {
  try {
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Decode a JWT without verifying it (we only care about the claims). */
export function decodeJwt(token: string): JwtInfo | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = b64urlDecode(parts[0]!);
  const payload = b64urlDecode(parts[1]!);
  if (!header || !payload) return null;
  try {
    const h = JSON.parse(header) as unknown;
    const p = JSON.parse(payload) as unknown;
    if (typeof h !== 'object' || h === null || typeof p !== 'object' || p === null) return null;
    return { header: h as Record<string, unknown>, payload: p as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Names that, when used as an env var, almost always hold a server-side secret. */
export const SECRET_NAME_RE =
  /(SECRET|SERVICE_?ROLE|PRIVATE_?KEY|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES_URL|MONGODB_URI|MONGO_URL|REDIS_URL|CONNECTION_STRING|WEBHOOK_SECRET|SIGNING|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|REPLICATE_API_TOKEN|RESEND_API_KEY|SENDGRID_API_KEY|POSTMARK|MAILGUN|TWILIO_AUTH|STRIPE_SECRET|STRIPE_SK|CLERK_SECRET|AWS_SECRET|AWS_ACCESS_KEY|ELEVENLABS_API_KEY|PINECONE_API_KEY|UPSTASH_REDIS_REST_TOKEN|GITHUB_TOKEN|ADMIN_KEY|MASTER_KEY)/i;

/**
 * Public-by-design values that look secret but are meant to ship to the browser.
 * (Supabase anon/publishable keys rely on RLS; Firebase web config is public; Stripe publishable keys.)
 */
export const PUBLIC_BY_DESIGN_RE =
  /(ANON_KEY|PUBLISHABLE|PUBLIC_KEY$|_PK$|FIREBASE_API_KEY|FIREBASE_APP_ID|MEASUREMENT_ID|POSTHOG_KEY|SENTRY_DSN|MAPBOX_TOKEN|MAPS_API_KEY|RECAPTCHA_SITE_KEY|TURNSTILE_SITE_KEY|SITE_KEY|PUSHER_KEY|ALGOLIA_SEARCH_KEY|ALGOLIA_APP_ID|CLERK_PUBLISHABLE)/i;

export const PUBLIC_ENV_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'REACT_APP_', 'EXPO_PUBLIC_', 'PUBLIC_', 'NUXT_PUBLIC_', 'GATSBY_'];

export function publicPrefixOf(name: string): string | null {
  for (const p of PUBLIC_ENV_PREFIXES) if (name.startsWith(p)) return p;
  return null;
}

export function looksSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name) && !PUBLIC_BY_DESIGN_RE.test(name);
}
