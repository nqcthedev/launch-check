import { describe, expect, it } from 'vitest';
import { findGenericSecrets, findProviderSecrets } from '../../src/rules/secrets.js';
import { FAKE, findings, nextPkg } from '../helpers.js';

describe('findProviderSecrets', () => {
  it.each([
    ['Stripe live secret key', FAKE.stripeLive],
    ['Stripe test secret key', FAKE.stripeTest],
    ['OpenAI API key', FAKE.openai],
    ['Anthropic API key', FAKE.anthropic],
    ['AWS access key ID', FAKE.aws],
    ['GitHub token', FAKE.github],
    ['Google API key', FAKE.google],
    ['Private key (PEM)', FAKE.pem],
    ['Database URL with password', FAKE.dbUrl],
    ['Supabase service_role key', FAKE.jwt('service_role')],
  ])('detects %s', (kind, value) => {
    const hits = findProviderSecrets(`const x = "${value}";`);
    expect(hits.map((h) => h.kind)).toEqual([kind]);
  });

  it('does not flag Anthropic keys as OpenAI keys', () => {
    expect(findProviderSecrets(FAKE.anthropic).map((h) => h.kind)).toEqual(['Anthropic API key']);
  });

  it('ignores Supabase anon keys (public by design)', () => {
    expect(findProviderSecrets(FAKE.jwt('anon'))).toEqual([]);
  });

  it('ignores placeholders and local database URLs', () => {
    const text = [
      'STRIPE_SECRET_KEY=sk_' + 'live_xxxxxxxxxxxxxxxxxxxxxxxx',
      'OPENAI_API_KEY=sk-proj-your-key-here-0000000000000000',
      'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app',
      'DATABASE_URL=postgresql://user:password@db.example.com:5432/app',
    ].join('\n');
    expect(findProviderSecrets(text)).toEqual([]);
  });
});

describe('findGenericSecrets', () => {
  it('flags high-entropy literals assigned to secret-looking names', () => {
    const hits = findGenericSecrets(`const apiSecret = "q8Zr2Lx9Vm4Tn7Wk1Pb6Yd3Hs5Jc0Gf";`);
    expect(hits).toHaveLength(1);
  });

  it('ignores low-entropy strings, identifiers and env lookups', () => {
    const src = [
      `const tokenCookieName = "auth-token-cookie-name";`,
      `const password = "aaaaaaaaaaaaaaaaaaaaaa";`,
      `const API_KEY_HEADER = "x-api-key-header-value";`,
      `const secret = process.env.SECRET;`,
      `const publicKey = "pk_live_q8Zr2Lx9Vm4Tn7Wk1Pb6Yd3";`,
    ].join('\n');
    expect(findGenericSecrets(src)).toEqual([]);
  });
});

describe('secrets/hardcoded-key', () => {
  it('reports a hard-coded key with redacted evidence and notes browser exposure', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        'app/page.tsx': `'use client';\nimport { pay } from '../lib/pay';\nexport default function P() { return null }`,
        'lib/pay.ts': `export const key = '${FAKE.stripeLive}';\nexport function pay() {}`,
      },
      'secrets/hardcoded-key',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'critical', file: 'lib/pay.ts', line: 1 });
    expect(out[0]!.message).toContain('bundled into the browser');
    expect(out[0]!.snippet).not.toContain(FAKE.stripeLive);
    expect(out[0]!.message).not.toContain(FAKE.stripeLive);
  });

  it('scans .env.example templates but not real .env files', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        '.env.example': `OPENAI_API_KEY=${FAKE.openai}\n`,
        '.env': `OPENAI_API_KEY=${FAKE.openai}\n`,
        '.gitignore': '.env\n',
      },
      'secrets/hardcoded-key',
    );
    expect(out.map((f) => f.file)).toEqual(['.env.example']);
  });

  it('passes clean code', async () => {
    const out = await findings(
      { 'package.json': nextPkg(), 'lib/pay.ts': `export const key = process.env.STRIPE_SECRET_KEY;` },
      'secrets/hardcoded-key',
    );
    expect(out).toEqual([]);
  });
});

describe('secrets/env-file-committed', () => {
  it('flags a non-gitignored .env containing secrets as critical', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        '.gitignore': '.env*.local\n',
        '.env': `NEXT_PUBLIC_SITE_URL=https://x.dev\nSTRIPE_SECRET_KEY=${FAKE.stripeLive}\n`,
      },
      'secrets/env-file-committed',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'critical', file: '.env', line: 2 });
    expect(out[0]!.message).toContain('STRIPE_SECRET_KEY');
    expect(JSON.stringify(out)).not.toContain(FAKE.stripeLive);
  });

  it('is low severity when the file only holds public values', async () => {
    const out = await findings(
      { 'package.json': nextPkg(), '.env': `NEXT_PUBLIC_SITE_URL=https://x.dev\n` },
      'secrets/env-file-committed',
    );
    expect(out.map((f) => f.severity)).toEqual(['low']);
  });

  it('passes when .env files are gitignored, and ignores templates', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        '.gitignore': '.env*\n!.env.example\n',
        '.env.local': `STRIPE_SECRET_KEY=${FAKE.stripeLive}\n`,
        '.env.example': `STRIPE_SECRET_KEY=your-key\n`,
      },
      'secrets/env-file-committed',
    );
    expect(out).toEqual([]);
  });
});

describe('secrets/public-env-secret', () => {
  it('flags secret-looking public-prefixed variables in env files and code (once per name)', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        '.env.local': `NEXT_PUBLIC_OPENAI_API_KEY=${FAKE.openai}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${FAKE.jwt('anon')}\n`,
        'lib/ai.ts': `export const k = process.env.NEXT_PUBLIC_OPENAI_API_KEY;\nexport const s = import.meta.env.VITE_STRIPE_SECRET_KEY;`,
      },
      'secrets/public-env-secret',
    );
    expect(out.map((f) => f.title).sort()).toEqual([
      'NEXT_PUBLIC_OPENAI_API_KEY is shipped to the browser',
      'VITE_STRIPE_SECRET_KEY is shipped to the browser',
    ]);
    const openai = out.find((f) => f.title.startsWith('NEXT_PUBLIC_OPENAI'))!;
    expect(openai.message).toContain('OpenAI API key');
    expect(openai.message).toContain('Seen 2 times');
  });

  it('flags a public variable whose value is a provider secret even if the name looks harmless', async () => {
    const out = await findings({ 'package.json': nextPkg(), '.env': `VITE_PAYMENTS=${FAKE.stripeLive}\n` }, 'secrets/public-env-secret');
    expect(out).toHaveLength(1);
  });

  it('allows public-by-design keys', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        '.env': `NEXT_PUBLIC_SUPABASE_ANON_KEY=x\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_x\nVITE_FIREBASE_API_KEY=x\n`,
      },
      'secrets/public-env-secret',
    );
    expect(out).toEqual([]);
  });
});

describe('secrets/server-env-in-client', () => {
  const files = (clientCode: string) => ({
    'package.json': nextPkg(),
    'app/page.tsx': `'use client';\nimport { x } from '@/lib/util';\n${clientCode}\nexport default function P() { return x }`,
    'lib/util.ts': `export const x = process.env.RESEND_API_KEY;`,
  });

  it('flags server secrets read in modules reachable from "use client"', async () => {
    const out = await findings(files(''), 'secrets/server-env-in-client');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 'lib/util.ts', line: 1 });
    expect(out[0]!.message).toContain('imported via app/page.tsx');
  });

  it('ignores the same code when only imported from server components', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        'app/page.tsx': `import { x } from '@/lib/util';\nexport default function P() { return x }`,
        'lib/util.ts': `export const x = process.env.RESEND_API_KEY;`,
      },
      'secrets/server-env-in-client',
    );
    expect(out).toEqual([]);
  });

  it('does not follow imports into "use server" modules', async () => {
    const out = await findings(
      {
        'package.json': nextPkg(),
        'app/page.tsx': `'use client';\nimport { save } from './actions';\nexport default function P() { return null }`,
        'app/actions.ts': `'use server';\nexport async function save() { return process.env.RESEND_API_KEY }`,
      },
      'secrets/server-env-in-client',
    );
    expect(out).toEqual([]);
  });
});
