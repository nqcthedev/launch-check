import type { FindingInput, ProjectContext } from '../types.js';
import { LineIndex, maskSqlComments, snippetOf } from '../utils/text.js';
import { defineRule, envRefs, matchAll } from './helpers.js';

function sqlFiles(ctx: ProjectContext): string[] {
  return ctx.files
    .map((f) => f.path)
    .filter((p) => p.endsWith('.sql'))
    .sort((a, b) => {
      // Migrations apply in filename order; keep that order, seed files last.
      const seedA = /seed/i.test(a) ? 1 : 0;
      const seedB = /seed/i.test(b) ? 1 : 0;
      return seedA - seedB || (a < b ? -1 : a > b ? 1 : 0);
    });
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;

function normalizeTable(raw: string): { schema: string; table: string; key: string } {
  const parts = raw.split('.').map((p) => p.trim().replace(/^"|"$/g, ''));
  const table = parts.length > 1 ? parts[1]! : parts[0]!;
  const schema = parts.length > 1 ? parts[0]! : 'public';
  const norm = (s: string) => (/^[a-z_][a-z0-9_$]*$/i.test(s) ? s.toLowerCase() : s);
  return { schema: norm(schema), table: norm(table), key: `${norm(schema)}.${norm(table)}` };
}

const STATEMENT_RES = {
  create: new RegExp(
    String.raw`\bcreate\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QUALIFIED}(\s+partition\s+of\b)?`,
    'gi',
  ),
  enable: new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED}\s+enable\s+row\s+level\s+security`, 'gi'),
  disable: new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QUALIFIED}\s+disable\s+row\s+level\s+security`, 'gi'),
  drop: new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?${QUALIFIED}`, 'gi'),
};

/** Schemas exposed through the Supabase Data API by default. */
const EXPOSED_SCHEMAS = new Set(['public']);

export const rlsDisabledRule = defineRule({
  id: 'supabase/rls-disabled',
  title: 'Table without Row Level Security',
  category: 'supabase',
  severity: 'critical',
  why:
    'Supabase exposes every table in the public schema through its REST API. The anon key ships in your frontend, so without RLS ' +
    'anyone can read, modify or delete every row with a single curl command. This is the most common breach in AI-built apps.',
  fix:
    'Add `alter table <name> enable row level security;` in a new migration, then write policies scoped to the owner, e.g. ' +
    '`create policy "own rows" on <name> for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`.',
  appliesTo: (ctx) => sqlFiles(ctx).length > 0,
  run(ctx) {
    type Event = { kind: 'create' | 'enable' | 'disable' | 'drop'; key: string; schema: string; table: string; file: string; index: number; order: number };
    const events: Event[] = [];
    let order = 0;
    for (const file of sqlFiles(ctx)) {
      const sql = maskSqlComments(ctx.read(file));
      const local: Event[] = [];
      for (const kind of ['create', 'enable', 'disable', 'drop'] as const) {
        const re = STATEMENT_RES[kind];
        re.lastIndex = 0;
        for (const m of sql.matchAll(re)) {
          if (kind === 'create' && m[2]) continue; // partitions inherit the parent's RLS
          const t = normalizeTable(m[1]!);
          local.push({ kind, ...t, file, index: m.index ?? 0, order: 0 });
        }
      }
      local.sort((a, b) => a.index - b.index);
      for (const e of local) events.push({ ...e, order: order++ });
    }
    const state = new Map<string, { enabled: boolean; file: string; index: number; disabledExplicitly: boolean; table: string }>();
    for (const e of events) {
      if (e.kind === 'create') {
        if (!state.has(e.key)) state.set(e.key, { enabled: false, file: e.file, index: e.index, disabledExplicitly: false, table: e.table });
      } else if (e.kind === 'drop') {
        state.delete(e.key);
      } else {
        const s = state.get(e.key) ?? { enabled: false, file: e.file, index: e.index, disabledExplicitly: false, table: e.table };
        s.enabled = e.kind === 'enable';
        if (e.kind === 'disable') {
          s.disabledExplicitly = true;
          s.file = e.file;
          s.index = e.index;
        }
        state.set(e.key, s);
      }
    }
    const out: FindingInput[] = [];
    for (const [key, s] of state) {
      const schema = key.split('.')[0]!;
      if (s.enabled || !EXPOSED_SCHEMAS.has(schema)) continue;
      const text = ctx.read(s.file);
      const idx = new LineIndex(text);
      const line = idx.lineOf(s.index);
      out.push({
        title: `Table "${s.table}" has Row Level Security ${s.disabledExplicitly ? 'explicitly disabled' : 'disabled'}`,
        message: s.disabledExplicitly
          ? `RLS is turned off for ${key} by a later migration; the table is readable and writable with the public anon key.`
          : `${key} is created without \`enable row level security\` in any migration; the table is readable and writable with the public anon key.`,
        file: s.file,
        line,
        snippet: snippetOf(idx.line(line)),
      });
    }
    return out;
  },
});

function stripParens(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim();
  return e.toLowerCase();
}

/** Extract the parenthesised expression following `keyword` (e.g. using / with check). */
function clause(stmt: string, keyword: RegExp): string | null {
  const m = keyword.exec(stmt);
  if (!m) return null;
  const start = (m.index ?? 0) + m[0].length - 1; // position of "("
  let depth = 0;
  for (let i = start; i < stmt.length; i++) {
    if (stmt[i] === '(') depth++;
    else if (stmt[i] === ')') {
      depth--;
      if (depth === 0) return stmt.slice(start, i + 1);
    }
  }
  return null;
}

export const permissivePolicyRule = defineRule({
  id: 'supabase/permissive-policy',
  title: 'RLS policy that allows everything',
  category: 'supabase',
  severity: 'high',
  why:
    'A policy with `using (true)` or `with check (true)` turns RLS back off for that operation: it is equivalent to no protection. ' +
    'AI tools generate these to make "permission denied" errors go away.',
  fix:
    'Scope the policy to the row owner, e.g. `using (auth.uid() = user_id)` and `with check (auth.uid() = user_id)`. ' +
    'Keep `true` only for SELECT on genuinely public data (e.g. published blog posts) and say so in a comment.',
  appliesTo: (ctx) => sqlFiles(ctx).length > 0,
  run(ctx) {
    const out: FindingInput[] = [];
    for (const file of sqlFiles(ctx)) {
      const original = ctx.read(file);
      const sql = maskSqlComments(original);
      const idx = new LineIndex(original);
      const re = new RegExp(String.raw`\bcreate\s+policy\s+("[^"]+"|[\w$]+)\s+on\s+${QUALIFIED}([^;]*)`, 'gi');
      for (const m of sql.matchAll(re)) {
        const name = m[1]!.replace(/^"|"$/g, '');
        const table = normalizeTable(m[2]!);
        const rest = m[3]!;
        const cmd = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest)?.[1] ?? 'all').toLowerCase();
        const roles = (/\bto\s+([\w\s,"]+?)(?=\s+(?:using|with)\b|$)/i.exec(rest)?.[1] ?? 'public')
          .split(',')
          .map((r) => r.trim().replace(/"/g, '').toLowerCase());
        if (roles.every((r) => r === 'service_role' || r === 'postgres')) continue;
        if (/\bas\s+restrictive\b/i.test(rest)) continue;
        const using = clause(rest, /\busing\s*\(/i);
        const check = clause(rest, /\bwith\s+check\s*\(/i);
        const open = [using, check].some((c) => c !== null && stripParens(c) === 'true');
        if (!open) continue;
        const authOnly = roles.length > 0 && roles.every((r) => r === 'authenticated');
        const isRead = cmd === 'select';
        const severity = isRead ? (authOnly ? 'low' : 'medium') : 'high';
        const who = authOnly ? 'any signed-in user' : 'anyone with your public anon key';
        const action = isRead ? 'read every row of' : cmd === 'all' ? 'read, insert, update and delete every row of' : `${cmd} any row in`;
        const line = idx.lineOf(m.index ?? 0);
        out.push({
          severity,
          title: `Policy "${name}" lets ${who} ${isRead ? 'read' : 'write'} "${table.table}"`,
          message: `Policy "${name}" on ${table.key} (FOR ${cmd.toUpperCase()}, TO ${roles.join(', ')}) uses \`true\`: ${who} can ${action} ${table.table}.`,
          file,
          line,
          snippet: snippetOf(idx.line(line)),
        });
      }
    }
    return out;
  },
});

export const serviceRoleInClientRule = defineRule({
  id: 'supabase/service-role-in-client',
  title: 'Supabase service_role key used in browser code',
  category: 'supabase',
  severity: 'critical',
  why:
    'The service_role key bypasses every RLS policy. Any module that reaches the browser bundle exposes it (or, if the env var is not public, ' +
    'the code is broken and someone will "fix" it by making it public). This is full admin access to your database.',
  fix:
    'Create the admin client in a server-only module (`import "server-only"` at the top of lib/supabase/admin.ts) and use it exclusively from ' +
    'route handlers / server actions after checking the user. In the browser use the anon key with RLS policies.',
  appliesTo: (ctx) => ctx.clientFiles().size > 0,
  run(ctx) {
    const out: FindingInput[] = [];
    for (const file of [...ctx.clientFiles()].sort()) {
      const code = ctx.code(file);
      if (!/service_?role/i.test(code)) continue;
      const original = ctx.read(file);
      const idx = new LineIndex(original);
      const refs = envRefs(code, original).filter((r) => /SERVICE_?ROLE/i.test(r.name));
      const literal = matchAll(original, code, /['"`]service_role['"`]/g);
      const first = refs[0]?.line ?? literal[0]?.line;
      if (!first) continue;
      const chain = ctx.clientChain(file);
      out.push({
        title: `service_role key referenced in client module ${file}`,
        message:
          `${file} is part of the browser bundle${chain.length > 1 ? ` (imported via ${chain.slice(1).join(' ← ')})` : ' (it is a client entry)'}` +
          `${refs[0] ? ` and reads ${refs[0].name}` : ' and references the service_role key'}.`,
        file,
        line: first,
        snippet: snippetOf(idx.line(first)),
      });
    }
    return out;
  },
});

const FIREBASE_RULE_FILES = /(^|\/)(firestore|storage)(\.[\w-]+)?\.rules$/;

export const firebaseOpenRulesRule = defineRule({
  id: 'firebase/open-security-rules',
  title: 'Firebase security rules allow public access',
  category: 'firebase',
  severity: 'critical',
  why:
    'Firestore / Storage / Realtime Database are called directly from the browser. Rules are the only thing between the internet and your data; ' +
    '`if true` or the 30-day "test mode" rule leaves the whole database open (and test mode silently locks you out when it expires).',
  fix:
    'Replace with per-user rules, e.g. `match /users/{uid}/{doc=**} { allow read, write: if request.auth != null && request.auth.uid == uid; }`, ' +
    'and test them with the Firebase emulator.',
  appliesTo: (ctx) => ctx.files.some((f) => FIREBASE_RULE_FILES.test(f.path) || /(^|\/)database\.rules\.json$/.test(f.path)),
  run(ctx) {
    const out: FindingInput[] = [];
    for (const f of ctx.files) {
      if (FIREBASE_RULE_FILES.test(f.path)) {
        const text = ctx.read(f.path);
        const masked = text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
        for (const m of matchAll(text, masked, /\ballow\s+([\w\s,]+?)\s*(?::\s*if\s+([^;]+))?;/g)) {
          const cond = (m.groups[1] ?? '').trim();
          const ops = m.groups[0]!.trim();
          const always = cond === '' || cond === 'true';
          const testMode = /request\.time\s*<\s*timestamp\.date\(/.test(cond);
          if (!always && !testMode) continue;
          const writes = /write|create|update|delete/.test(ops);
          out.push({
            severity: always ? (writes ? 'critical' : 'high') : 'high',
            title: always ? `Firebase rule "allow ${ops}" with no condition` : 'Firebase rules still in test mode',
            message: always
              ? `${f.path} allows ${ops} for everyone, including unauthenticated visitors.`
              : `${f.path} uses the time-limited test-mode rule: everything is public until the date, then everything is denied.`,
            file: f.path,
            line: m.line,
            snippet: m.snippet,
          });
        }
      } else if (/(^|\/)database\.rules\.json$/.test(f.path)) {
        const text = ctx.read(f.path);
        for (const m of matchAll(text, text, /"\.(read|write)"\s*:\s*(true|"true")/g)) {
          out.push({
            severity: m.groups[0] === 'write' ? 'critical' : 'high',
            title: `Realtime Database "${'.' + m.groups[0]}": true`,
            message: `${f.path} grants public ${m.groups[0]} access.`,
            file: f.path,
            line: m.line,
            snippet: m.snippet,
          });
        }
      }
    }
    return out;
  },
});

export const supabaseRules = [rlsDisabledRule, permissivePolicyRule, serviceRoleInClientRule, firebaseOpenRulesRule];
