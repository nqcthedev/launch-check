import { posix } from 'node:path';
import type { FindingInput, Location, ProjectContext } from '../types.js';
import { LineIndex, lineCount, maskSource, parseJsonc, snippetOf } from '../utils/text.js';
import { parseVersion } from '../utils/version.js';
import { defineRule, envRefs, isConfigFile, isEnvTemplate, matchAll, parseDotenv, plural } from './helpers.js';

interface TsConfig {
  extends?: string | string[];
  compilerOptions?: { strict?: boolean; noImplicitAny?: boolean; strictNullChecks?: boolean };
}

function resolveTsconfig(ctx: ProjectContext, file: string, depth = 0): TsConfig['compilerOptions'] {
  const json = parseJsonc<TsConfig>(ctx.read(file));
  if (!json) return {};
  let base: TsConfig['compilerOptions'] = {};
  const ext = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
  for (const e of ext) {
    if (depth > 5) break;
    if (e.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(file), e.endsWith('.json') ? e : `${e}.json`));
      base = { ...base, ...resolveTsconfig(ctx, target, depth + 1) };
    } else if (/strict/i.test(e)) {
      base = { ...base, strict: true };
    } else if (ctx.exists(`node_modules/${e}`)) {
      const target = ctx.exists(`node_modules/${e}/tsconfig.json`) ? `node_modules/${e}/tsconfig.json` : `node_modules/${e}`;
      base = { ...base, ...resolveTsconfig(ctx, target, depth + 1) };
    }
  }
  return { ...base, ...(json.compilerOptions ?? {}) };
}

export const typescriptStrictRule = defineRule({
  id: 'config/typescript-strict',
  title: 'TypeScript strict mode is off',
  category: 'config',
  severity: 'medium',
  why:
    'Without `strict`, TypeScript lets `null`/`undefined` flow anywhere and silently types unknown values as `any`. Most "Cannot read properties of undefined" ' +
    'crashes in production are errors strict mode would have caught at build time.',
  fix: 'Set `"strict": true` in tsconfig.json and fix the errors (`npx tsc --noEmit`). Enable it file-by-file with `// @ts-check` if the backlog is large.',
  appliesTo: (ctx) => ctx.exists('tsconfig.json'),
  run(ctx) {
    // Solution-style tsconfig (Vite templates): `files: []` + references. Check the referenced projects instead.
    const root = parseJsonc<TsConfig & { files?: unknown[]; references?: Array<{ path: string }> }>(ctx.read('tsconfig.json'));
    const targets =
      root?.references && Array.isArray(root.files) && root.files.length === 0
        ? root.references
            .map((r) => posix.normalize(r.path.endsWith('.json') ? r.path : posix.join(r.path, 'tsconfig.json')))
            .filter((p) => ctx.exists(p))
        : ['tsconfig.json'];
    // TypeScript 6+ enables `strict` by default; older versions default to non-strict.
    const tsMajor = parseVersion(ctx.detection.resolved.typescript ?? ctx.detection.versions.typescript)?.major ?? 0;
    const out: FindingInput[] = [];
    for (const file of targets) {
      const options = resolveTsconfig(ctx, file);
      const strict = options?.strict ?? (tsMajor >= 6 ? true : undefined);
      if (strict === true && options?.noImplicitAny !== false && options?.strictNullChecks !== false) continue;
      const text = ctx.read(file);
      const m = matchAll(text, text, /"(strict|noImplicitAny|strictNullChecks)"\s*:\s*false/g)[0];
      const what =
        strict === true
          ? `strict is on but ${options?.noImplicitAny === false ? 'noImplicitAny' : 'strictNullChecks'} is disabled`
          : options?.strict === false
            ? '"strict" is set to false'
            : '"strict" is not enabled (TypeScript before 6.0 defaults to non-strict)';
      out.push({ title: `${file}: ${what}`, message: `${file}: ${what}.`, file, ...(m ? { line: m.line, snippet: m.snippet } : {}) });
    }
    return out;
  },
});

const ANY_RE = /(?::\s*any\b(?!\s*=>)|\bas\s+any\b|<any>|\bany\[\]|Array<any>|Record<\s*\w+\s*,\s*any\s*>|Promise<any>)/g;

function codeFiles(ctx: ProjectContext): string[] {
  return ctx
    .sourceFiles()
    .map((f) => f.path)
    .filter((p) => !isConfigFile(p) && !/(^|\/)(scripts|migrations)\//.test(p));
}

function topFiles(counts: Map<string, number>, n = 3): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([f, c]) => `${f} (${c})`)
    .join(', ');
}

export const anyDensityRule = defineRule({
  id: 'code-quality/any-density',
  title: 'High density of `any`',
  category: 'code-quality',
  severity: 'low',
  why: 'Every `any` switches the type checker off for that value. A high density means TypeScript is mostly decorative and refactors break silently.',
  fix: 'Replace `any` with real types or `unknown` + narrowing; generate database types (`supabase gen types typescript`, Prisma client) instead of `any` rows.',
  appliesTo: (ctx) => ctx.detection.typescript,
  run(ctx) {
    let total = 0;
    let lines = 0;
    const perFile = new Map<string, number>();
    const locations: Location[] = [];
    for (const p of codeFiles(ctx)) {
      if (!/\.tsx?$/.test(p)) continue;
      const original = ctx.read(p);
      lines += lineCount(original);
      const masked = maskSource(original, { comments: true, strings: true });
      const hits = matchAll(original, masked, ANY_RE);
      if (hits.length === 0) continue;
      total += hits.length;
      perFile.set(p, hits.length);
      for (const h of hits) locations.push({ file: p, line: h.line });
    }
    if (lines === 0 || total === 0) return [];
    const perKloc = (total / lines) * 1000;
    const threshold = ctx.config.anyDensityThreshold;
    if (perKloc < threshold && total < 25) return [];
    return [
      {
        severity: perKloc >= threshold * 4 ? 'medium' : 'low',
        title: `${plural(total, 'explicit `any`', 'explicit `any`s')} (${perKloc.toFixed(1)} per 1,000 lines)`,
        message: `${plural(total, 'use')} of \`any\` across ${plural(perFile.size, 'file')}; most in ${topFiles(perFile)}.`,
        file: locations[0]!.file,
        line: locations[0]!.line,
        locations: locations.slice(0, 10),
        count: total,
      },
    ];
  },
});

export const consoleLogRule = defineRule({
  id: 'code-quality/console-log',
  title: 'Leftover console.log calls',
  category: 'code-quality',
  severity: 'low',
  why:
    'Debug logging in browser code leaks internal data (API responses, user objects, tokens) to anyone with DevTools open, and on the server it ' +
    'floods logs with unstructured noise that hides real errors.',
  fix: 'Remove debug logs, or use a logger with levels (pino, consola) and strip `console.log` in production builds (`compiler.removeConsole` in next.config).',
  run(ctx) {
    const client = ctx.clientFiles();
    const locations: Location[] = [];
    const perFile = new Map<string, number>();
    let inClient = 0;
    for (const p of codeFiles(ctx)) {
      const original = ctx.read(p);
      if (!original.includes('console.')) continue;
      const hits = matchAll(original, ctx.code(p), /\bconsole\.(log|debug|trace|dir|table)\s*\(/g);
      if (hits.length === 0) continue;
      perFile.set(p, hits.length);
      if (client.has(p)) inClient += hits.length;
      for (const h of hits) locations.push({ file: p, line: h.line });
    }
    if (locations.length === 0) return [];
    const over = locations.length > ctx.config.consoleLogThreshold;
    return [
      {
        severity: over || inClient > 0 ? 'low' : 'info',
        title: `${plural(locations.length, 'console.log call')} left in source`,
        message: `${plural(locations.length, 'debug log')} in ${plural(perFile.size, 'file')}${inClient ? ` (${inClient} in browser code)` : ''}; most in ${topFiles(perFile)}.`,
        file: locations[0]!.file,
        line: locations[0]!.line,
        locations: locations.slice(0, 10),
        count: locations.length,
      },
    ];
  },
});

export const debuggerRule = defineRule({
  id: 'code-quality/debugger',
  title: 'debugger statement',
  category: 'code-quality',
  severity: 'medium',
  why: 'A `debugger` statement pauses execution for any visitor with DevTools open and signals unfinished code.',
  fix: 'Delete the statement; enable the ESLint `no-debugger` rule to stop it coming back.',
  run(ctx) {
    const out: FindingInput[] = [];
    for (const p of codeFiles(ctx)) {
      const original = ctx.read(p);
      if (!original.includes('debugger')) continue;
      const masked = maskSource(original, { comments: true, strings: true });
      for (const m of matchAll(original, masked, /(?<![\w$.])debugger(?![\w$])\s*;?/g)) {
        out.push({ title: 'debugger statement left in code', message: `${p}:${m.line} contains a \`debugger\` statement.`, file: p, line: m.line, snippet: m.snippet });
      }
    }
    return out;
  },
});

export const todoRule = defineRule({
  id: 'code-quality/todo-comments',
  title: 'TODO / FIXME comments',
  category: 'code-quality',
  severity: 'info',
  why: 'AI-generated code often leaves "TODO: add auth" or "FIXME: validate input" where a real implementation is required. Each one is worth a look before launch.',
  fix: 'Review each marker; implement or track it in your issue tracker, then delete it.',
  run(ctx) {
    const locations: Location[] = [];
    let fixmes = 0;
    const securityTodos: Location[] = [];
    for (const p of codeFiles(ctx)) {
      const original = ctx.read(p);
      if (!/TODO|FIXME|HACK|XXX/.test(original)) continue;
      const code = ctx.code(p);
      const idx = new LineIndex(original);
      for (const m of original.matchAll(/\b(TODO|FIXME|HACK|XXX)\b/g)) {
        const at = m.index ?? 0;
        if (code[at] === original[at]) continue; // not inside a comment
        const line = idx.lineOf(at);
        locations.push({ file: p, line });
        if (m[1] !== 'TODO') fixmes++;
        if (/auth|secur|valid|sanitiz|permission|rls|rate.?limit|password|secret/i.test(idx.line(line))) securityTodos.push({ file: p, line });
      }
    }
    if (locations.length === 0) return [];
    const first = securityTodos[0] ?? locations[0]!;
    return [
      {
        severity: securityTodos.length > 0 ? 'low' : 'info',
        title: `${plural(locations.length, 'TODO/FIXME marker')}${securityTodos.length ? `, ${securityTodos.length} security-related` : ''}`,
        message:
          `${plural(locations.length, 'marker')} (${fixmes} FIXME/HACK/XXX).` +
          (securityTodos.length ? ` Security-related: ${securityTodos.map((l) => `${l.file}:${l.line}`).join(', ')}.` : ''),
        file: first.file,
        ...(first.line ? { line: first.line, snippet: snippetOf(new LineIndex(ctx.read(first.file)).line(first.line)) } : {}),
        locations: [...securityTodos, ...locations.filter((l) => !securityTodos.includes(l))].slice(0, 10),
        count: locations.length,
      },
    ];
  },
});

export const evalRule = defineRule({
  id: 'security/eval',
  title: 'Dynamic code execution (eval / new Function)',
  category: 'security',
  severity: 'high',
  why:
    '`eval`, `new Function` and string-based `setTimeout` execute arbitrary strings as code. If any part of that string comes from a user, a URL, ' +
    'or an LLM response, it is remote code execution (on the server) or XSS (in the browser).',
  fix: 'Use `JSON.parse` for data (validate it with zod), a lookup table for dynamic dispatch, or a sandboxed expression parser (e.g. expr-eval) for formulas.',
  run(ctx) {
    const out: FindingInput[] = [];
    for (const p of codeFiles(ctx)) {
      const original = ctx.read(p);
      if (!/eval|Function|setTimeout|setInterval/.test(original)) continue;
      const masked = maskSource(original, { comments: true, strings: true });
      const re = /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])(?:setTimeout|setInterval)\s*\(\s*['"`]/g;
      for (const m of matchAll(original, masked, re)) {
        const what = m.text.startsWith('eval') ? 'eval()' : m.text.startsWith('new') ? 'new Function()' : 'string-based timer';
        out.push({ title: `${what} executes a string as code`, message: `${p}:${m.line} uses ${what}.`, file: p, line: m.line, snippet: m.snippet });
      }
    }
    return out;
  },
});

export const corsRule = defineRule({
  id: 'security/cors-wildcard-credentials',
  title: 'CORS allows any origin with credentials',
  category: 'security',
  severity: 'high',
  why:
    'Allowing every origin (`*`, or reflecting the request Origin) while also allowing credentials lets any website make authenticated requests ' +
    'on behalf of your logged-in users and read the responses.',
  fix: 'Allow an explicit list of origins (`origin: ["https://app.example.com"]`) when credentials are needed, or drop credentials for public APIs.',
  run(ctx) {
    const out: FindingInput[] = [];
    const files = [...codeFiles(ctx), ...['vercel.json', 'netlify.toml', 'next.config.js', 'next.config.mjs', 'next.config.ts'].filter((f) => ctx.exists(f))];
    for (const p of [...new Set(files)]) {
      const original = ctx.read(p);
      if (!/origin/i.test(original)) continue;
      const code = p.endsWith('.json') || p.endsWith('.toml') ? original : ctx.code(p);
      const wildcard = matchAll(
        original,
        code,
        /access-control-allow-origin['"]?\s*[,:=]\s*(?:value\s*:\s*)?['"]\*['"]|\borigin\s*:\s*(?:['"]\*['"]|true\b)|access-control-allow-origin['"]?\s*[,:]\s*(?:req|request)\.headers/gi,
      );
      if (wildcard.length === 0) continue;
      const creds = /access-control-allow-credentials['"]?\s*[,:=]\s*(?:value\s*:\s*)?['"]?true|\bcredentials\s*:\s*true\b/i.test(code);
      if (!creds) continue;
      const w = wildcard[0]!;
      const how = /true/.test(w.text) || /headers/.test(w.text) ? 'reflects any request Origin' : 'allows any origin (`*`)';
      out.push({
        title: 'CORS allows any origin together with credentials',
        message: `${p} ${how} and also sends Access-Control-Allow-Credentials: true.`,
        file: p,
        line: w.line,
        snippet: w.snippet,
      });
    }
    return out;
  },
});

export const rawSqlRule = defineRule({
  id: 'security/sql-injection',
  title: 'SQL built from interpolated strings',
  category: 'security',
  severity: 'high',
  heuristic: true,
  why: 'Interpolating request data into raw SQL lets an attacker rewrite the query: read other users\' data, drop tables, or bypass auth.',
  fix:
    'Use parameterized queries: Prisma `$queryRaw` tagged template (not `$queryRawUnsafe`), Drizzle `sql` template (not `sql.raw`), ' +
    '`pool.query("... where id = $1", [id])`, or the Supabase query builder.',
  run(ctx) {
    const out: FindingInput[] = [];
    for (const p of codeFiles(ctx)) {
      const original = ctx.read(p);
      if (!/Unsafe|sql\.raw|\.query\s*\(|\.execute\s*\(/.test(original)) continue;
      const code = ctx.code(p);
      const re =
        /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+)|\bsql\.raw\s*\(\s*`[^`]*\$\{|\.(?:query|execute)\s*\(\s*`\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[^`]*\$\{|\.(?:query|execute)\s*\(\s*['"]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^'"]*['"]\s*\+/gi;
      for (const m of matchAll(original, code, re)) {
        out.push({ title: 'Raw SQL built with string interpolation', message: `${p}:${m.line} builds a SQL string from interpolated values.`, file: p, line: m.line, snippet: m.snippet });
      }
    }
    return out;
  },
});

/** Variables provided by the runtime / platform that never belong in .env.example. */
const BUILTIN_ENV = /^(NODE_ENV|NEXT_RUNTIME|NEXT_PHASE|PORT|HOST|HOSTNAME|PWD|HOME|CI|TZ|VERCEL|VERCEL_[A-Z_]+|NETLIFY|NETLIFY_[A-Z_]+|RENDER|RAILWAY_[A-Z_]+|FLY_[A-Z_]+|AWS_REGION|AWS_LAMBDA_[A-Z_]+|npm_[a-z_]+|DEV|PROD|MODE|SSR|BASE_URL|DEBUG|ANALYZE|NEXT_PUBLIC_VERCEL_[A-Z_]+|GITHUB_[A-Z_]+|RUNNER_[A-Z_]+|NO_COLOR|FORCE_COLOR|TERM|SHELL|USER|LANG|EDITOR)$/;

export const envExampleRule = defineRule({
  id: 'config/env-example',
  title: 'Env vars used in code but not documented',
  category: 'config',
  severity: 'low',
  why:
    'A deployment fails (or worse, runs with features silently disabled) when a variable the code needs is not set. .env.example is the checklist ' +
    'whoever deploys the app (you in six months, a client, Vercel) uses to configure it.',
  fix: 'Create or update .env.example with every variable the code reads, using placeholder values, and commit it.',
  run(ctx) {
    const used = new Map<string, Location>();
    for (const p of ctx.sourceFiles().map((f) => f.path)) {
      if (/(^|\/)(scripts)\//.test(p)) continue;
      const code = ctx.code(p);
      if (!/process\.env|import\.meta\.env/.test(code)) continue;
      for (const ref of envRefs(code, ctx.read(p))) {
        if (BUILTIN_ENV.test(ref.name) || used.has(ref.name)) continue;
        used.set(ref.name, { file: p, line: ref.line });
      }
    }
    if (used.size === 0) return [];
    const template = ctx.envFiles.find((e) => isEnvTemplate(e.path) && !e.path.includes('/'))?.path ?? ctx.envFiles.find((e) => isEnvTemplate(e.path))?.path;
    if (!template) {
      const first = [...used.values()][0]!;
      return [
        {
          severity: 'medium',
          title: 'No .env.example',
          message: `The code reads ${plural(used.size, 'environment variable')} (${[...used.keys()].slice(0, 8).join(', ')}${used.size > 8 ? ', …' : ''}) but there is no .env.example documenting them.`,
          file: first.file,
          ...(first.line ? { line: first.line } : {}),
        },
      ];
    }
    const documented = new Set(parseDotenv(ctx.read(template)).map((e) => e.name));
    const missing = [...used.entries()].filter(([name]) => !documented.has(name));
    if (missing.length === 0) return [];
    return [
      {
        title: `${plural(missing.length, 'env var')} missing from ${template}`,
        message: `Used in code but not listed in ${template}: ${missing.map(([n]) => n).join(', ')}.`,
        file: missing[0]![1].file,
        ...(missing[0]![1].line ? { line: missing[0]![1].line } : {}),
        locations: missing.map(([, l]) => l).slice(0, 10),
        count: missing.length,
      },
    ];
  },
});

export const codeRules = [
  typescriptStrictRule,
  anyDensityRule,
  consoleLogRule,
  debuggerRule,
  todoRule,
  evalRule,
  corsRule,
  rawSqlRule,
  envExampleRule,
];
