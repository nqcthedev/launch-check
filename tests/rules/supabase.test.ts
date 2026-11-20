import { describe, expect, it } from 'vitest';
import { findings, nextPkg } from '../helpers.js';

const pkg = nextPkg({ '@supabase/supabase-js': '^2.50.0' });

describe('supabase/rls-disabled', () => {
  it('flags public tables created without RLS', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'supabase/migrations/001_init.sql': [
          'create table public.todos (id bigint primary key);',
          'create table if not exists "Profiles" (id uuid primary key);',
          'create table private.audit_log (id bigint);',
          '-- create table public.commented_out (id int);',
        ].join('\n'),
      },
      'supabase/rls-disabled',
    );
    expect(out.map((f) => f.title)).toEqual([
      'Table "todos" has Row Level Security disabled',
      'Table "Profiles" has Row Level Security disabled',
    ]);
    expect(out[0]).toMatchObject({ severity: 'critical', file: 'supabase/migrations/001_init.sql', line: 1 });
  });

  it('accepts RLS enabled in the same or a later migration', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'supabase/migrations/001_init.sql': 'create table public.todos (id bigint);\ncreate table notes (id bigint);',
        'supabase/migrations/002_rls.sql': 'alter table public.todos enable row level security;\nALTER TABLE ONLY "public"."notes" ENABLE ROW LEVEL SECURITY;',
      },
      'supabase/rls-disabled',
    );
    expect(out).toEqual([]);
  });

  it('flags RLS that a later migration disables, and forgets dropped tables', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'supabase/migrations/001.sql': 'create table todos (id int);\nalter table todos enable row level security;\ncreate table tmp (id int);',
        'supabase/migrations/002.sql': 'alter table todos disable row level security;\ndrop table tmp;',
      },
      'supabase/rls-disabled',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain('explicitly disabled');
    expect(out[0]).toMatchObject({ file: 'supabase/migrations/002.sql', line: 1 });
  });
});

describe('supabase/permissive-policy', () => {
  it('flags write policies using true as high and public reads as medium', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'supabase/migrations/001.sql': [
          'create policy "all" on public.notes for all using (true) with check (true);',
          'create policy "read" on public.posts for select using ( true );',
          'create policy "auth read" on public.posts for select to authenticated using (true);',
        ].join('\n'),
      },
      'supabase/permissive-policy',
    );
    expect(out.map((f) => [f.severity, f.line])).toEqual([
      ['high', 1],
      ['medium', 2],
      ['low', 3],
    ]);
  });

  it('accepts owner-scoped policies, service_role-only policies and dropped policies', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'supabase/migrations/001.sql': [
          'create policy "own" on notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);',
          'create policy "svc" on notes for all to service_role using (true);',
          'create policy "temp" on notes for insert with check (true);',
        ].join('\n'),
        'supabase/migrations/002.sql': 'drop policy if exists "temp" on notes;',
      },
      'supabase/permissive-policy',
    );
    expect(out).toEqual([]);
  });
});

describe('supabase/service-role-in-client', () => {
  it('flags the service role key referenced from browser code', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'app/page.tsx': `'use client';\nimport { supabase } from '../lib/db';\nexport default function P() { return null }`,
        'lib/db.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);`,
      },
      'supabase/service-role-in-client',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'critical', file: 'lib/db.ts', line: 2 });
  });

  it('allows the service role in server-only modules', async () => {
    const out = await findings(
      {
        'package.json': pkg,
        'app/page.tsx': `'use client';\nexport default function P() { return null }`,
        'app/api/x/route.ts': `import { admin } from '../../../lib/admin';\nexport async function GET() { return admin }`,
        'lib/admin.ts': `import 'server-only';\nexport const admin = process.env.SUPABASE_SERVICE_ROLE_KEY;`,
      },
      'supabase/service-role-in-client',
    );
    expect(out).toEqual([]);
  });

  it('treats every module reachable from a Vite entry as browser code', async () => {
    const out = await findings(
      {
        'package.json': { dependencies: { react: '19.0.0', vite: '6.0.0', '@vitejs/plugin-react': '4.0.0' } },
        'index.html': '<script type="module" src="/src/main.tsx"></script>',
        'src/main.tsx': `import './lib/supabase';`,
        'src/lib/supabase.ts': `export const key = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY;`,
      },
      'supabase/service-role-in-client',
    );
    expect(out.map((f) => f.file)).toEqual(['src/lib/supabase.ts']);
  });
});

describe('firebase/open-security-rules', () => {
  it('flags allow-all rules and test mode', async () => {
    const out = await findings(
      {
        'package.json': { dependencies: { firebase: '11.0.0' } },
        'firestore.rules': [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /{document=**} {',
          '      allow read, write: if true;',
          '    }',
          '    match /legacy/{id} {',
          '      allow read, write: if request.time < timestamp.date(2025, 1, 1);',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        'database.rules.json': '{ "rules": { ".read": true, ".write": false } }',
      },
      'firebase/open-security-rules',
    );
    expect(out.map((f) => [f.severity, f.file, f.line])).toEqual([
      ['critical', 'firestore.rules', 5],
      ['high', 'firestore.rules', 8],
      ['medium', 'database.rules.json', 1],
    ]);
  });

  it('accepts auth-scoped rules', async () => {
    const out = await findings(
      {
        'package.json': { dependencies: { firebase: '11.0.0' } },
        'firestore.rules': 'match /users/{uid} {\n  allow read, write: if request.auth != null && request.auth.uid == uid;\n}',
      },
      'firebase/open-security-rules',
    );
    expect(out).toEqual([]);
  });
});
