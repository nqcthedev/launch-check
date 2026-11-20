import { describe, expect, it } from 'vitest';
import { findings, nextPkg } from '../helpers.js';

const base = { 'package.json': nextPkg(), 'app/layout.tsx': 'export default function L({ children }) { return children }', 'app/page.tsx': 'export default function P() { return null }' };

describe('nextjs/build-checks-disabled', () => {
  it('flags ignoreBuildErrors (high) and ignoreDuringBuilds (low)', async () => {
    const out = await findings(
      { ...base, 'next.config.js': 'module.exports = { typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } }' },
      'nextjs/build-checks-disabled',
    );
    expect(out.map((f) => f.severity)).toEqual(['high', 'low']);
  });

  it('ignores commented-out settings', async () => {
    const out = await findings({ ...base, 'next.config.mjs': 'export default {\n  // typescript: { ignoreBuildErrors: true },\n}' }, 'nextjs/build-checks-disabled');
    expect(out).toEqual([]);
  });
});

describe('nextjs/images-unoptimized', () => {
  it('flags unoptimized images on a server-rendered app', async () => {
    const out = await findings({ ...base, 'next.config.js': 'module.exports = { images: { unoptimized: true } }' }, 'nextjs/images-unoptimized');
    expect(out).toHaveLength(1);
  });

  it('allows it for static exports', async () => {
    const out = await findings(
      { ...base, 'next.config.js': "module.exports = { output: 'export', images: { unoptimized: true } }" },
      'nextjs/images-unoptimized',
    );
    expect(out).toEqual([]);
  });
});

describe('nextjs/missing-error-boundary and nextjs/missing-not-found', () => {
  it('flags an App Router app without error.tsx / not-found.tsx', async () => {
    expect(await findings(base, 'nextjs/missing-error-boundary')).toHaveLength(1);
    expect(await findings(base, 'nextjs/missing-not-found')).toHaveLength(1);
  });

  it('passes when nested error.tsx and root not-found.tsx exist', async () => {
    const files = { ...base, 'app/(app)/dashboard/error.tsx': "'use client'", 'app/not-found.tsx': 'x' };
    expect(await findings(files, 'nextjs/missing-error-boundary')).toEqual([]);
    expect(await findings(files, 'nextjs/missing-not-found')).toEqual([]);
  });

  it('understands the Pages Router', async () => {
    const files = { 'package.json': nextPkg(), 'pages/index.tsx': 'x', 'pages/404.tsx': 'x', 'pages/_error.tsx': 'x' };
    expect(await findings(files, 'nextjs/missing-error-boundary')).toEqual([]);
    expect(await findings(files, 'nextjs/missing-not-found')).toEqual([]);
  });
});

describe('security/server-module-in-client', () => {
  it('flags server SDKs imported (directly or transitively) into client components', async () => {
    const out = await findings(
      {
        ...base,
        'components/Pay.tsx': `'use client';\nimport { stripe } from '@/lib/stripe';\nimport fs from 'node:fs';\nexport default function Pay() { return null }`,
        'lib/stripe.ts': `import Stripe from 'stripe';\nexport const stripe = new Stripe('x');`,
      },
      'security/server-module-in-client',
    );
    expect(out.map((f) => [f.file, f.title, f.severity])).toEqual([
      ['lib/stripe.ts', 'Client bundle imports "stripe"', 'high'],
      ['components/Pay.tsx', 'Client bundle imports "node:fs"', 'medium'],
    ]);
    expect(out[0]!.message).toContain('imported via components/Pay.tsx');
  });

  it('ignores type-only imports and server components', async () => {
    const out = await findings(
      {
        ...base,
        'components/Pay.tsx': `'use client';\nimport type Stripe from 'stripe';\nexport default function Pay(p: { s: Stripe }) { return null }`,
        'app/api/pay/route.ts': `import Stripe from 'stripe';\nexport async function POST() {}`,
      },
      'security/server-module-in-client',
    );
    expect(out).toEqual([]);
  });
});

describe('security/dangerously-set-inner-html', () => {
  it('flags dynamic HTML', async () => {
    const out = await findings(
      { ...base, 'components/Note.tsx': 'export const Note = ({ n }) => <div dangerouslySetInnerHTML={{ __html: n.content }} />;' },
      'security/dangerously-set-inner-html',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('n.content');
  });

  it('allows constants, sanitized HTML and JSON-LD', async () => {
    const out = await findings(
      {
        ...base,
        'components/Safe.tsx': [
          `export const A = () => <div dangerouslySetInnerHTML={{ __html: '<b>hi</b>' }} />;`,
          `export const B = ({ h }) => <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(h) }} />;`,
          `export const C = ({ d }) => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(d) }} />;`,
        ].join('\n'),
      },
      'security/dangerously-set-inner-html',
    );
    expect(out).toEqual([]);
  });
});

describe('security/unauthenticated-route (heuristic)', () => {
  it('flags mutating route handlers, pages API routes and server actions without auth', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/todos/[id]/route.ts': [
          `import { db } from '@/lib/db';`,
          `export async function GET() { return Response.json({ ok: true }) }`,
          `export async function DELETE(req: Request, { params }: { params: { id: string } }) {`,
          `  await db.from('todos').delete().eq('id', params.id);`,
          `  return Response.json({ ok: true });`,
          `}`,
        ].join('\n'),
        'pages/api/admin.ts': `export default async function handler(req, res) { await prisma.user.deleteMany(); res.json({}) }`,
        'app/actions.ts': `'use server';\nexport async function save(fd: FormData) { await db.from('x').update({}) }`,
      },
      'security/unauthenticated-route',
    );
    expect(out.map((f) => f.title).sort()).toEqual([
      'API route /api/admin has no auth check',
      'Route handler DELETE /api/todos/[id] has no auth check',
      'Server action save() has no auth check',
    ]);
    expect(out.every((f) => f.heuristic)).toBe(true);
  });

  it('accepts handlers that check the user', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/todos/route.ts': [
          `export async function POST(req: Request) {`,
          `  const { data: { user } } = await supabase.auth.getUser();`,
          `  if (!user) return new Response('Unauthorized', { status: 401 });`,
          `  await supabase.from('todos').insert({ user_id: user.id });`,
          `}`,
        ].join('\n'),
        'app/actions.ts': `'use server';\nexport async function save() { const session = await auth(); await db.from('x').update({}) }`,
      },
      'security/unauthenticated-route',
    );
    expect(out).toEqual([]);
  });

  it('downgrades routes that rely only on middleware', async () => {
    const out = await findings(
      {
        ...base,
        'middleware.ts': `export function middleware(req) { const s = getSession(req); if (!s) return NextResponse.redirect('/login') }\nexport const config = { matcher: ['/api/:path*'] };`,
        'app/api/todos/route.ts': `export async function POST() { await db.from('todos').insert({}) }`,
      },
      'security/unauthenticated-route',
    );
    expect(out.map((f) => [f.severity, f.title])).toEqual([['low', 'Route handler POST /api/todos relies on middleware for auth']]);
  });
});

describe('security/unverified-webhook (heuristic)', () => {
  it('flags Stripe webhooks that never verify the signature', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/webhooks/stripe/route.ts': `export async function POST(req: Request) {\n  const event = await req.json();\n  if (event.type === 'checkout.session.completed') {}\n}`,
      },
      'security/unverified-webhook',
    );
    expect(out.map((f) => f.severity)).toEqual(['critical']);
  });

  it('accepts constructEvent', async () => {
    const out = await findings(
      {
        ...base,
        'app/api/webhooks/stripe/route.ts': `export async function POST(req: Request) {\n  const event = stripe.webhooks.constructEvent(await req.text(), sig, secret);\n  if (event.type === 'checkout.session.completed') {}\n}`,
      },
      'security/unverified-webhook',
    );
    expect(out).toEqual([]);
  });
});
