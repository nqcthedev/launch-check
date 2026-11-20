/**
 * Regressions found by running launch-check over 300 public AI-built repositories and reading a sample
 * of the findings by hand (November 2026). Each case is a false positive, or a mislabelled severity, seen in real code.
 */
import { describe, expect, it } from 'vitest';
import { exportsOnlyTypes, parseImports } from '../../src/graph.js';
import { findProviderSecrets } from '../../src/rules/secrets.js';
import { functionBody } from '../../src/rules/nextjs.js';
import { FAKE, findings, nextPkg } from '../helpers.js';

const supa = nextPkg({ '@supabase/supabase-js': '^2.50.0' });
const base = { 'package.json': nextPkg(), 'app/layout.tsx': 'export default function L({ children }) { return children }', 'app/page.tsx': 'export default function P() { return null }' };
const titles = (out: Array<{ title: string }>) => out.map((f) => f.title);

describe('supabase/rls-disabled: field regressions', () => {
  it('ignores temporary tables', async () => {
    const out = await findings(
      { 'package.json': supa, 'scripts/check.sql': 'create temp table r (label text primary key);\nCREATE TEMPORARY TABLE scratch (id int);\ncreate table real_one (id int);' },
      'supabase/rls-disabled',
    );
    expect(titles(out)).toEqual(['Table "real_one" has Row Level Security disabled']);
  });

  it('ignores DDL keywords inside string literals and SQL test fixtures', async () => {
    const out = await findings(
      {
        'package.json': supa,
        'supabase/baseline.sql': "create event trigger t on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function f();",
        'tests/fixtures/live-tables.sql': 'create table public.some_table (id bigint not null);',
      },
      'supabase/rls-disabled',
    );
    expect(out).toEqual([]);
  });

  it('does not apply to plain Postgres behind Prisma or Drizzle (no Supabase in the project)', async () => {
    const out = await findings(
      { 'package.json': nextPkg({ '@prisma/client': '^6.0.0', '@clerk/nextjs': '^6.0.0' }), 'db/schema.sql': 'CREATE TABLE chat_rounds (id bigint primary key);' },
      'supabase/rls-disabled',
    );
    expect(out).toEqual([]);
  });
});

describe('supabase/permissive-policy: field regressions', () => {
  const run = (sql: string) => findings({ 'package.json': supa, 'supabase/migrations/001.sql': sql }, 'supabase/permissive-policy');

  it('rates an insert-only open policy as medium (public forms are legitimate)', async () => {
    const out = await run('create policy "Anyone can submit feedback" on feedback for insert with check (true);');
    expect(out.map((f) => [f.severity, f.title])).toEqual([['medium', 'Policy "Anyone can submit feedback" lets anyone with your public anon key insert into "feedback"']]);
  });

  it('keeps update/delete/all with using (true) at high', async () => {
    const out = await run(
      [
        'create policy "Sessions updatable by all" on sessions for update using (true);',
        'create policy "wipe" on sessions for delete to authenticated using (true);',
        'create policy "Service role full access" on departments using (true) with check (true);',
      ].join('\n'),
    );
    expect(out.map((f) => f.severity)).toEqual(['high', 'high', 'high']);
    expect(out[1]!.message).toContain('any signed-in user can delete any row');
  });

  it('does not claim "any row" when USING is scoped and only WITH CHECK is true', async () => {
    const out = await run('create policy "tickets_update_own" on tickets for update to authenticated using (user_id = (select auth.uid())) with check (true);');
    expect(out.map((f) => [f.severity, f.title])).toEqual([['low', 'Policy "tickets_update_own" does not validate updated rows of "tickets"']]);
  });

  it('treats FOR ALL with a scoped USING but an open WITH CHECK as an open insert', async () => {
    const out = await run('create policy "mine" on notes for all using (auth.uid() = user_id) with check (true);');
    expect(out.map((f) => f.severity)).toEqual(['medium']);
  });
});

describe('firebase/open-security-rules: field regressions', () => {
  it('rates an unconditional read as medium and an unconditional write as critical', async () => {
    const out = await findings(
      {
        'package.json': nextPkg({ firebase: '^11.0.0' }),
        'firestore.rules': [
          'service cloud.firestore { match /databases/{db}/documents {',
          '  match /listings/{id} { allow get, list: if true; allow delete: if false; }',
          '  match /{document=**} { allow read, write: if true; }',
          '} }',
        ].join('\n'),
      },
      'firebase/open-security-rules',
    );
    expect(out.map((f) => f.severity).sort()).toEqual(['critical', 'medium']);
  });
});

describe('secrets/hardcoded-key: field regressions', () => {
  it('needs key material after a PEM header', () => {
    expect(findProviderSecrets(`if (!key.includes("${FAKE.pemHeader}")) throw new Error('bad key');`)).toEqual([]);
    expect(findProviderSecrets(`GOOGLE_PRIVATE_KEY="${FAKE.pemHeader}\\n...\\n-----END PRIVATE KEY-----\\n"`)).toEqual([]);
    expect(findProviderSecrets(`FIREBASE_PRIVATE_KEY="${FAKE.pemHeader}\\nYour private key here\\n-----END PRIVATE KEY-----"`)).toEqual([]);
    expect(findProviderSecrets(`{ "private_key": "${FAKE.pem}" }`).map((h) => h.kind)).toEqual(['Private key (PEM)']);
    expect(findProviderSecrets(`${FAKE.pemHeader}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDUMMY0\n-----END PRIVATE KEY-----`).length).toBe(1);
  });

  it('ignores interpolated and bracket-placeholder database URLs', () => {
    const proto = ['postgres', 'ql://'].join('');
    expect(findProviderSecrets('return `' + proto + '${env.DB_USER}:${encodeURIComponent(env.DB_PASSWORD)}@${host}:${port}/app`;')).toEqual([]);
    expect(findProviderSecrets(`# Format: ${proto}postgres.[ref]:[PASSWORD]@[host]:6543/postgres`)).toEqual([]);
    expect(findProviderSecrets(`DATABASE_URL="${proto}postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres"`)).toEqual([]);
    expect(findProviderSecrets(`const u = "${FAKE.dbUrl}"`).map((h) => h.kind)).toEqual(['Database URL with password']);
  });

  it('ignores the shared service_role key of the local Supabase stack', () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const demo = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 })}.FAKE-signature-for-tests`;
    expect(findProviderSecrets(`const k = "${demo}"`)).toEqual([]);
  });

  it('skips fakes in tests and mocks, but keeps critical hits there', async () => {
    const slack = ['xo', 'xb-', '111111111111-222222222222-abcdefABCDEF'].join('');
    const out = await findings(
      {
        ...base,
        'tests/slack.test.ts': `const SLACK_TOKEN = "${slack}";\nconst userToken = 'valid-user-token-123';\nconst apiSecret = "Zx81kQp0Lm3Nv7Rt5Yw2Bc9D";`,
        'src/test-setup.ts': `const sessionSecret = "Zx81kQp0Lm3Nv7Rt5Yw2Bc9D";`,
        'tests/db.test.ts': `const url = "${FAKE.dbUrl}";`,
        'lib/session.ts': `const userToken = 'valid-user-token-123';`,
      },
      'secrets/hardcoded-key',
    );
    expect(out.map((f) => [f.file, f.severity])).toEqual([['tests/db.test.ts', 'critical']]);
  });

  it('ignores computed template literals, namespaced labels and CI/test-fixture files', async () => {
    const out = await findings(
      {
        ...base,
        'lib/session.ts': "const _DEV_EPHEMERAL_SECRET = `merchant-dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;\nconst ADMIN_PASSWORD_SALT = 'zurichjs:admin-password:v1';",
        'test-fixtures/security-flaw.js': 'const jwt_secret = "Zx81kQp0Lm3Nv7Rt5Yw2Bc9D";',
        'lib/push.ts': 'const VAPID_PRIVATE_KEY = "VHaIyQ81kQp0Lm3Nv7Rt5Yw2Bc9DxZ81kQp0Lm3Nv7R";',
      },
      'secrets/hardcoded-key',
    );
    expect(out.map((f) => f.file)).toEqual(['lib/push.ts']);
  });

  it('reports a Firebase web config key as info and a Gemini key as high', async () => {
    const out = await findings(
      {
        ...base,
        'lib/firebase.ts': `export const firebaseConfig = {\n  apiKey: "${FAKE.google}",\n  authDomain: "demo.firebaseapp.com",\n  projectId: "demo",\n};`,
        'lib/genkit.ts': `import { googleAI } from '@genkit-ai/googleai';\nconst GOOGLE_API_KEY = "${FAKE.google}";\nexport const ai = genkit({ plugins: [googleAI({ apiKey: GOOGLE_API_KEY })] });`,
      },
      'secrets/hardcoded-key',
    );
    expect(out.map((f) => [f.file, f.severity]).sort()).toEqual([
      ['lib/firebase.ts', 'info'],
      ['lib/genkit.ts', 'high'],
    ]);
  });
});

describe('secrets/public-env-secret and env files: field regressions', () => {
  it('allows Mapbox public tokens, the Firebase database URL and browser keys', async () => {
    const out = await findings(
      {
        ...base,
        'components/map.tsx': [
          `'use client';`,
          `const a = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;`,
          `const b = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL;`,
          `const c = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;`,
          `const d = process.env.NEXT_PUBLIC_GEMINI_API_KEY;`,
        ].join('\n'),
      },
      'secrets/public-env-secret',
    );
    expect(titles(out)).toEqual(['NEXT_PUBLIC_GEMINI_API_KEY is shipped to the browser']);
  });

  it('treats .env.example.latest as a template and .env.test as test credentials', async () => {
    const out = await findings(
      {
        ...base,
        'templates/.env.example.latest': 'DATABASE_URL=postgres://u:hunter2hunter2@db.internal.io/app',
        'e2e/.env.test': 'JWT_SECRET=local-only-secret-for-docker-compose',
        '.env.production': 'JWT_SECRET=Zx81kQp0Lm3Nv7Rt5Yw2Bc9D',
        'apps/web/.env': `VITE_GOOGLE_MAPS_BROWSER_KEY=${FAKE.google}`,
      },
      'secrets/env-file-committed',
    );
    expect(out.map((f) => [f.file, f.severity]).sort()).toEqual([
      ['.env.production', 'critical'],
      ['apps/web/.env', 'low'],
      ['e2e/.env.test', 'medium'],
    ]);
  });
});

describe('security/unauthenticated-route: field regressions', () => {
  it('finds the body behind a return type that contains an object type', () => {
    const src = `export async function revoke(id: string): Promise<{ ok: boolean; error?: string }> {\n  const u = await currentUser();\n  return { ok: true };\n}\nexport async function other() { return 1 }`;
    const [start, end] = functionBody(src, 0);
    expect(src.slice(start, end)).toContain('currentUser()');
    expect(src.slice(start, end)).not.toContain('other');
  });

  it('accepts project-specific guards, wrappers and typed server actions', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/import/route.ts': `export async function POST(request: Request) {\n  const authError = await requireManagementAuth(request);\n  if (authError) return authError;\n  await db.insert(rows).values({});\n}`,
        'app/api/suites/[id]/route.ts': `export const PUT = hasPermission(\n  async (request, context) => {\n    return controller.update(request);\n  },\n  'suites',\n  'update',\n);\nexport const DELETE = guarded(async (request) => { await db.delete(suites); });`,
        'app/actions/keys.ts': `'use server';\nexport async function revokeKey(id: string): Promise<{ ok: boolean; error?: string }> {\n  const { supabase, user } = await currentUser();\n  if (!user) return { ok: false };\n  await supabase.from('api_keys').update({ revoked: true }).eq('id', id);\n  return { ok: true };\n}\nexport async function createTemplate(input: Input) {\n  const session = await checkAdminAuth();\n  await db.insert(templates).values(input);\n}`,
      },
      'security/unauthenticated-route',
    );
    expect(titles(out)).toEqual(['Route handler DELETE /api/suites/[id] has no auth check']);
  });

  it('skips admin gates with unusual names, handlers that delegate, and static stubs', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/v2/admin/proposals/route.ts': `export async function POST(request: Request) {\n  const gate = await apiAdmin(request);\n  if (gate.response) return gate.response;\n  await db.insert(proposals).values({});\n}`,
        'app/api/monitoring/scan/route.ts': `export async function GET(request: Request) {\n  const session = await getServerSession();\n  if (!session) return new Response('no', { status: 401 });\n  await db.insert(scans).values({});\n}\nexport async function POST(request: Request) {\n  return GET(request)\n}`,
        'app/api/portfolio/rebalance/route.ts': `export async function POST() {\n  return NextResponse.json(data)\n}`,
        'app/api/admin/users/role/route.ts': `export async function PATCH(req: Request) {\n  const { id, role } = await req.json();\n  await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);\n}`,
      },
      'security/unauthenticated-route',
    );
    expect(titles(out)).toEqual(['Route handler PATCH /api/admin/users/role has no auth check']);
  });

  it('skips sign-up/sign-in endpoints and non-function exports of "use server" files', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/auth/register/route.ts': `export async function POST(request: Request) {\n  const { email, password } = await request.json();\n  await supabase.auth.signUp({ email, password });\n  await db.from('profiles').insert({ email });\n}`,
        'app/ai/prompts.ts': `'use server';\nexport const outlinePrompt = ai.definePrompt({ name: 'outline', model: 'gemini' });\nexport async function formatTitle(t: string) { return t.trim(); }`,
        'app/ai/actions.ts': `'use server';\nexport async function reportReview(id: string) {\n  const supabase = createAdminClient();\n  await supabase.from('reviews').update({ reported: true }).eq('id', id);\n}`,
      },
      'security/unauthenticated-route',
    );
    expect(titles(out)).toEqual(['Server action reportReview() has no auth check']);
  });
});

describe('security/unverified-webhook: field regressions', () => {
  it('does not mistake React hooks or components for webhook receivers', async () => {
    const out = await findings(
      {
        ...base,
        'src/hooks/useBodyScrollLock.ts': `export default function useBodyScrollLock(locked: boolean) { return locked }`,
        'src/hooks/use-refetch.ts': `const useRefetch = () => 1;\nexport default useRefetch;`,
        'components/WebhookSettings.tsx': `export default function WebhookSettings() { return null }`,
      },
      'security/unverified-webhook',
    );
    expect(out).toEqual([]);
  });

  it('ignores scripts and tests that only mention Stripe event names', async () => {
    const out = await findings(
      { ...base, 'scripts/test-full-subscription-flow.js': `const req = build();\nconst event = { type: 'checkout.session.completed' };\nawait fetch(url, { method: 'POST', body: JSON.stringify(event) });` },
      'security/unverified-webhook',
    );
    expect(out).toEqual([]);
  });

  it('accepts shared-secret headers, signature helpers and authenticated management routes', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/webhooks/telegram/route.ts': `export async function POST(req: Request) {\n  const secretHeader = req.headers.get('x-telegram-bot-api-secret-token');\n  if (secretHeader !== process.env.TELEGRAM_WEBHOOK_SECRET) return new Response('no', { status: 401 });\n}`,
        'app/api/stripe/webhook/route.js': `export async function POST(req) {\n  const secret = process.env.STRIPE_WEBHOOK_SECRET;\n  const event = await createStripeWebhookEvent(req, secret);\n  if (event.type === 'checkout.session.completed') {}\n}`,
        'app/api/scripts/[id]/webhook/regenerate/route.ts': `export async function POST(req: Request) {\n  const session = await getServerSession();\n  if (!session) return new Response('no', { status: 401 });\n}`,
        'app/api/webhooks/github/route.ts': `export async function POST(req: Request) {\n  const payload = await req.json();\n  await db.insert(events).values(payload);\n}`,
      },
      'security/unverified-webhook',
    );
    expect(out.map((f) => f.file)).toEqual(['app/api/webhooks/github/route.ts']);
  });
});

describe('security/dangerously-set-inner-html: field regressions', () => {
  it('ignores <style> blocks (shadcn/ui chart.tsx) and JSON-LD scripts', async () => {
    const out = await findings(
      {
        ...base,
        'components/ui/chart.tsx': `export function ChartStyle({ id, config }) {\n  return (\n    <style\n      dangerouslySetInnerHTML={{\n        __html: Object.entries(THEMES).map(([theme, prefix]) => prefix + id).join("\\n"),\n      }}\n    />\n  );\n}`,
        'components/seo.tsx': `export function Faq({ data }) {\n  return <script\n    type="application/ld+json"\n    dangerouslySetInnerHTML={{ __html: safeJsonLd(data) }}\n  />;\n}`,
        'components/post.tsx': `export function Post({ post }) { return <div dangerouslySetInnerHTML={{ __html: post.body }} /> }`,
      },
      'security/dangerously-set-inner-html',
    );
    expect(out.map((f) => f.file)).toEqual(['components/post.tsx']);
  });
});

describe('client import graph: field regressions', () => {
  it('treats inline type-only named imports as erased', () => {
    const refs = parseImports(`import { type AppRouter } from "~/server/api/root";\nimport { type A, b } from "./x";\nimport type { C } from "./y";`);
    expect(refs.map((r) => [r.specifier, r.typeOnly])).toEqual([
      ['~/server/api/root', true],
      ['./x', false],
      ['./y', true],
    ]);
  });

  it('knows when every imported name is a type in the target module', () => {
    const route = `export interface SearchResult { id: string }\nexport type Page = { n: number };\nexport async function GET() {}`;
    expect(exportsOnlyTypes(route, ['SearchResult', 'Page'])).toBe(true);
    expect(exportsOnlyTypes(route, ['SearchResult', 'GET'])).toBe(false);
    expect(exportsOnlyTypes(route, ['Missing'])).toBe(false);
  });

  it('does not pull tRPC routers or route handlers into the client bundle through type imports', async () => {
    const out = await findings(
      {
        'package.json': nextPkg({ 'drizzle-orm': '^0.40.0', postgres: '^3.4.0' }),
        'app/layout.tsx': 'export default function L({ children }) { return children }',
        'src/trpc/react.tsx': `'use client';\nimport { type AppRouter } from "../server/api/root";\nexport const api = createTRPCReact<AppRouter>();`,
        'src/server/api/root.ts': `import { db } from "../db";\nexport const appRouter = router({});\nexport type AppRouter = typeof appRouter;`,
        'src/server/db.ts': `import postgres from "postgres";\nexport const db = postgres(process.env.DATABASE_URL!);`,
        'lib/hooks/use-search.ts': `'use client';\nimport { SearchResult } from "../../app/api/search/route";\nexport function useSearch(): SearchResult[] { return [] }`,
        'app/api/search/route.ts': `import postgres from "postgres";\nexport interface SearchResult { id: string }\nexport async function GET() { return Response.json([]) }`,
      },
      'security/server-module-in-client',
    );
    expect(out).toEqual([]);
  });
});
