import type { FindingInput, ProjectContext, Severity } from '../types.js';
import {
  PUBLIC_BY_DESIGN_RE,
  decodeJwt,
  isPlaceholder,
  looksSecretEnvName,
  publicPrefixOf,
  redact,
  redactInLine,
  shannonEntropy,
} from '../utils/secrets.js';
import { LineIndex, snippetOf } from '../utils/text.js';
import { isTestPath } from '../context.js';
import { defineRule, envRefs, isEnvTemplate, isSourcePath, parseDotenv, plural } from './helpers.js';

export interface SecretHit {
  kind: string;
  value: string;
  index: number;
  severity: Severity;
  note?: string;
}

interface Provider {
  kind: string;
  re: RegExp;
  severity: Severity;
  note?: string;
  validate?: (value: string) => { ok: boolean; kind?: string; severity?: Severity; note?: string };
}

const LOCAL_HOST_RE = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|db|postgres|mysql|redis|mongo)(:\d+)?[/?]/i;

/**
 * Provider-specific key formats. Patterns intentionally accept `-`/`_` inside the body so that
 * clearly-fake fixture keys (e.g. `sk_live_DUMMY-...`) still exercise them.
 */
const PROVIDERS: Provider[] = [
  {
    kind: 'Private key (PEM)',
    // The header alone is not a key: code that checks `.includes("-----BEGIN PRIVATE KEY-----")` and placeholders
    // ("-----BEGIN PRIVATE KEY-----\n...\n-----END") are everywhere. Require real base64 key material after it.
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?=(?:\\r|\\n|\s|&#10;|["'`+,]){1,12}[A-Za-z0-9+/]{40,})/g,
    severity: 'critical',
  },
  { kind: 'Anthropic API key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g, severity: 'critical' },
  {
    kind: 'OpenAI API key',
    re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b|\bsk-[A-Za-z0-9]{48}\b/g,
    severity: 'critical',
  },
  { kind: 'Stripe live secret key', re: /\b(?:sk|rk)_live_[A-Za-z0-9_-]{16,}/g, severity: 'critical', note: 'Clerk secret keys share this prefix.' },
  { kind: 'Stripe test secret key', re: /\b(?:sk|rk)_test_[A-Za-z0-9_-]{16,}/g, severity: 'medium', note: 'Test-mode only, but still lets anyone act on your test account.' },
  { kind: 'Stripe webhook signing secret', re: /\bwhsec_[A-Za-z0-9_-]{24,}/g, severity: 'high' },
  { kind: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g, severity: 'critical' },
  { kind: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 'critical' },
  {
    kind: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: 'medium',
    note: 'Google API keys are only safe to publish when they are restricted (HTTP referrer / API restrictions) in Google Cloud Console.',
  },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/g, severity: 'critical' },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, severity: 'high' },
  { kind: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, severity: 'high' },
  {
    kind: 'Database URL with password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s:'"@/]+:[^\s'"@/]{6,}@[^\s'"`]+/g,
    severity: 'critical',
    validate: (v) => {
      const password = /:\/\/[^:]+:([^@]+)@/.exec(v)?.[1] ?? '';
      if (LOCAL_HOST_RE.test(`${v}/`) || isPlaceholder(password) || /^\$\{?[A-Z_]+\}?$/.test(password)) return { ok: false };
      // Template literals (`postgres://${user}:${pass}@${host}`) and documentation ("postgres://user:[PASSWORD]@[HOST]") hold no secret.
      if (/\$\{|\\\$|[[\]<>{}]|%s/.test(v)) return { ok: false };
      return { ok: true };
    },
  },
  {
    kind: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g,
    severity: 'critical',
    validate: (v) => {
      const jwt = decodeJwt(v);
      const role = jwt?.payload.role;
      // The service_role key printed by `supabase start` is the same for every local stack and unlocks nothing hosted.
      if (role === 'service_role' && jwt?.payload.iss === 'supabase-demo') return { ok: false };
      if (role === 'service_role') {
        return {
          ok: true,
          kind: 'Supabase service_role key',
          severity: 'critical',
          note: 'The service_role key bypasses Row Level Security: it is full read/write access to your database.',
        };
      }
      // anon keys are public by design; other JWTs are usually sample/session tokens.
      return { ok: false };
    },
  },
];

/** Find provider-format secrets in raw text. Placeholders ("sk_live_xxx", "your-key") are ignored. */
export function findProviderSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const taken: Array<[number, number]> = [];
  for (const p of PROVIDERS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const value = m[0];
      const index = m.index ?? 0;
      if (taken.some(([s, e]) => index < e && index + value.length > s)) continue;
      if (p.kind !== 'Private key (PEM)' && p.kind !== 'JWT' && isPlaceholder(value)) continue;
      let kind = p.kind;
      let severity = p.severity;
      let note = p.note;
      if (p.validate) {
        const v = p.validate(value);
        if (!v.ok) continue;
        kind = v.kind ?? kind;
        severity = v.severity ?? severity;
        note = v.note ?? note;
      }
      taken.push([index, index + value.length]);
      hits.push({ kind, value, index, severity, ...(note ? { note } : {}) });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const GENERIC_ASSIGN_RE =
  /\b([A-Za-z_$][\w$]*(?:secret|token|api_?key|apikey|password|passwd|private_?key|access_?key|client_?secret|auth_?key|credentials?)[\w$]*)['"]?\s*[:=]\s*(['"`])([^'"`\s]{16,})\2/gi;

/** High-entropy string literals assigned to secret-looking names. */
export function findGenericSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  GENERIC_ASSIGN_RE.lastIndex = 0;
  for (const m of text.matchAll(GENERIC_ASSIGN_RE)) {
    const name = m[1]!;
    const value = m[3]!;
    if (/^(NEXT_PUBLIC_|VITE_|PUBLIC_)/.test(name) && !looksSecretEnvName(name)) continue;
    if (/(public|publishable|anon|site_?key|token_?(url|endpoint|type)|_url$|_path$|_name$|_header$)/i.test(name)) continue;
    if (isPlaceholder(value)) continue;
    if (/^(https?:|\/|\.\/|[A-Z][A-Z0-9_]+$)/.test(value)) continue; // URLs, paths, env var names
    if (value.includes('${')) continue; // a template literal is computed at runtime, not a stored secret
    if (/^[a-z]+(?:[-_.:/][a-z0-9]+)+$/i.test(value) && /[a-z]{3,}[-_.:/][a-z]{3,}/i.test(value) && !/[A-Za-z0-9]{20,}/.test(value)) continue; // readable identifiers: "auth-token-cookie", "valid-user-token-123"
    const entropy = shannonEntropy(value);
    if (entropy < 3.5) continue;
    if (!/\d/.test(value) && value.length < 32) continue;
    hits.push({
      kind: `High-entropy value assigned to "${name}"`,
      value,
      index: (m.index ?? 0) + m[0].lastIndexOf(value),
      severity: 'high',
    });
  }
  return hits;
}

/** Redact every recognisable secret in a piece of text (used for all snippets in every report). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const hit of [...findProviderSecrets(text), ...findGenericSecrets(text)]) out = redactInLine(out, hit.value);
  return out;
}

const TEST_SUPPORT_RE =
  /(^|\/)(?:[\w.]+-)?(mocks?|fixtures?|test-utils?|testing|tests?)(?:-[\w.]+)?\/|(^|\/)ci\/|(^|\/)(test-setup|setup-?tests?|jest\.setup|vitest\.setup)\.[cm]?[jt]sx?$|\.mock\.[cm]?[jt]sx?$|(^|[\/._-])test[._-][\w.-]*$/i;

/**
 * `AIza...` is one format for two very different things: the Firebase web config key, which Firebase documents as
 * public, and keys for paid Google APIs (Gemini), which are secrets. Tell them apart by what surrounds the key.
 */
function classifyGoogleKey(hit: SecretHit, text: string, idx: LineIndex): SecretHit {
  const line = idx.lineOf(hit.index);
  const lines = text.split(/\r?\n/);
  const around = lines.slice(Math.max(0, line - 9), line + 8).join('\n');
  if (/authDomain|storageBucket|messagingSenderId|measurementId|firebaseapp\.com|firebaseConfig/i.test(around)) {
    return {
      ...hit,
      kind: 'Firebase web API key',
      severity: 'info',
      note: 'Firebase web config keys are public by design; your Firestore/Storage security rules are what protect the data.',
    };
  }
  if (/gemini|generative-?ai|genai|googleAI\b|GOOGLE_API_KEY/i.test(text)) {
    return { ...hit, kind: 'Google API key used with a Gemini client', severity: 'high', note: 'A Gemini key is billed to you: anyone holding it can spend your quota.' };
  }
  return hit;
}

const SCAN_SKIP_RE = /(^|\/)(package\.json|tsconfig[\w.-]*\.json|jsconfig\.json|composer\.lock|.*\.lock)$/;

export const hardcodedSecretRule = defineRule({
  id: 'secrets/hardcoded-key',
  title: 'Hard-coded secret',
  category: 'secrets',
  severity: 'critical',
  why:
    'Anything committed to the repository is readable by everyone with access to it, forever (git history keeps it even after deletion). ' +
    'Leaked API keys are scraped from public repos within minutes and used for fraud, data theft, or to run up your bill.',
  fix:
    'Rotate the key in the provider dashboard first (assume it is compromised), then move it to an environment variable that is only read on the server ' +
    '(Vercel/Netlify project settings, or a gitignored .env.local), and purge it from git history if the repo was ever public.',
  run(ctx) {
    const out: FindingInput[] = [];
    const client = ctx.clientFiles();
    for (const file of ctx.files) {
      if (SCAN_SKIP_RE.test(file.path)) continue;
      const isEnv = /(^|\/)\.env/.test(file.path) || file.path.endsWith('.env');
      // Real .env files are covered by secrets/env-file-committed; templates are scanned here.
      if (isEnv && !isEnvTemplate(file.path)) continue;
      const text = ctx.read(file.path);
      if (!text) continue;
      const idx = new LineIndex(text);
      // Test suites and mocks are full of provider-shaped fakes ("xoxb-111...", "whsec_test..."). Only keep what is
      // critical even there (a real private key, a live key, a database URL pointing at a real host).
      const inTest = isTestPath(file.path) || TEST_SUPPORT_RE.test(file.path);
      const hits = findProviderSecrets(text)
        .filter((h) => !inTest || h.severity === 'critical')
        .map((h) => (h.kind === 'Google API key' ? classifyGoogleKey(h, text, idx) : h));
      if (isSourcePath(file.path) && !inTest) {
        const generic = findGenericSecrets(ctx.code(file.path)).filter(
          (g) => !hits.some((h) => idx.lineOf(h.index) === idx.lineOf(g.index)),
        );
        hits.push(...generic);
      }
      for (const hit of hits) {
        const line = idx.lineOf(hit.index);
        const inClient = client.has(file.path);
        const where = isEnvTemplate(file.path)
          ? 'in an env template that is meant to be committed'
          : inClient
            ? 'in a file that is bundled into the browser JavaScript'
            : 'in source code';
        out.push({
          severity: hit.severity,
          title: `${hit.kind} hard-coded ${isEnvTemplate(file.path) ? 'in env template' : 'in source'}`,
          message: `Found ${hit.kind} (${redact(hit.value)}) ${where}.${hit.note ? ` ${hit.note}` : ''}`,
          file: file.path,
          line,
          column: idx.columnOf(hit.index),
          snippet: snippetOf(redactInLine(idx.line(line), hit.value)),
        });
      }
    }
    return out;
  },
});

export const envFileCommittedRule = defineRule({
  id: 'secrets/env-file-committed',
  title: '.env file committed or not gitignored',
  category: 'secrets',
  severity: 'critical',
  why:
    '.env files hold production credentials. If one is committed, every collaborator, CI log, fork and (for public repos) the whole internet gets your keys. ' +
    'AI builders often create .env and a .gitignore that only covers .env.local.',
  fix:
    'Add `.env*` (and `!.env.example`) to .gitignore, run `git rm --cached <file>`, rotate every secret that was in it, and keep only placeholder values in a committed .env.example.',
  run(ctx) {
    const out: FindingInput[] = [];
    const tracked = ctx.gitTracked();
    for (const env of ctx.envFiles) {
      if (isEnvTemplate(env.path)) continue;
      const isTracked = tracked?.has(env.path) ?? false;
      if (env.gitignored && !isTracked) continue;
      const text = ctx.read(env.path);
      const entries = parseDotenv(text);
      const idx = new LineIndex(text);
      const nameAt = new Map(entries.map((e) => [e.line, e.name]));
      // A Google Maps / Firebase browser key is published on purpose; its `AIza` shape alone does not make it a secret.
      const providerHits = findProviderSecrets(text).filter(
        (h) => !(h.kind === 'Google API key' && PUBLIC_BY_DESIGN_RE.test(nameAt.get(idx.lineOf(h.index)) ?? '')),
      );
      const secretLines = new Set(providerHits.map((h) => idx.lineOf(h.index)));
      const secretNames: string[] = [];
      let firstLine: number | undefined;
      for (const e of entries) {
        const isSecret =
          secretLines.has(e.line) || (looksSecretEnvName(e.name) && e.value.length > 0 && !isPlaceholder(e.value));
        if (isSecret) {
          secretNames.push(e.name);
          firstLine ??= e.line;
        }
      }
      const status = isTracked ? 'is tracked by git' : 'is not covered by .gitignore, so the next `git add .` commits it';
      // .env.test / e2e/.env hold throwaway credentials for a local stack far more often than production ones.
      const testEnv = /(^|\/)\.env\.(test|testing|ci|e2e)(\.|$)/.test(env.path) || isTestPath(env.path);
      if (secretNames.length > 0) {
        out.push({
          severity: testEnv ? 'medium' : 'critical',
          title: `${env.path} with live secrets ${isTracked ? 'is committed' : 'is not gitignored'}`,
          message: `${env.path} ${status}. It contains ${plural(secretNames.length, 'secret-looking value')}: ${secretNames.join(', ')}.`,
          file: env.path,
          ...(firstLine ? { line: firstLine, snippet: `${secretNames[0]}=${'*'.repeat(8)}` } : {}),
        });
      } else if (entries.length > 0) {
        out.push({
          severity: 'low',
          title: `${env.path} ${isTracked ? 'is committed' : 'is not gitignored'}`,
          message: `${env.path} ${status}. It currently holds no secret-looking values, but it is where secrets get added later.`,
          file: env.path,
        });
      }
    }
    return out;
  },
});

/** Env var names that are public-prefixed but look like secrets. */
function exposedSecretName(name: string): string | null {
  const prefix = publicPrefixOf(name);
  if (!prefix) return null;
  const rest = name.slice(prefix.length);
  return looksSecretEnvName(rest) || looksSecretEnvName(name) ? prefix : null;
}

export const publicEnvSecretRule = defineRule({
  id: 'secrets/public-env-secret',
  title: 'Secret exposed through a public env prefix',
  category: 'secrets',
  severity: 'critical',
  why:
    'Variables prefixed NEXT_PUBLIC_, VITE_, REACT_APP_ or EXPO_PUBLIC_ are inlined into the JavaScript sent to every visitor at build time. ' +
    'Anyone can open DevTools and copy them. AI tools add the prefix to "fix" an undefined variable in a client component.',
  fix:
    'Remove the public prefix, read the variable only in server code (route handler, server action, edge function), and call that from the browser. ' +
    'Rotate the key: it has already been shipped to browsers.',
  run(ctx) {
    const byName = new Map<string, { file: string; line: number; snippet: string; uses: number; valueKind?: string }>();
    const note = (name: string, file: string, line: number, snippet: string, valueKind?: string) => {
      const existing = byName.get(name);
      if (existing) {
        existing.uses++;
        if (valueKind && !existing.valueKind) existing.valueKind = valueKind;
        return;
      }
      byName.set(name, { file, line, snippet, uses: 1, ...(valueKind ? { valueKind } : {}) });
    };
    for (const env of ctx.envFiles) {
      const text = ctx.read(env.path);
      for (const e of parseDotenv(text)) {
        const prefix = publicPrefixOf(e.name);
        if (!prefix) continue;
        const valueHit = e.value ? findProviderSecrets(e.value)[0] : undefined;
        if (exposedSecretName(e.name) || valueHit) {
          note(e.name, env.path, e.line, `${e.name}=${e.value ? '*'.repeat(8) : ''}`, valueHit?.kind);
        }
      }
    }
    for (const file of ctx.sourceFiles()) {
      const code = ctx.code(file.path);
      if (!/process\.env|import\.meta\.env/.test(code)) continue;
      const original = ctx.read(file.path);
      const idx = new LineIndex(original);
      for (const ref of envRefs(code, original)) {
        if (exposedSecretName(ref.name)) note(ref.name, file.path, ref.line, snippetOf(idx.line(ref.line)));
      }
    }
    const out: FindingInput[] = [];
    for (const [name, info] of byName) {
      out.push({
        title: `${name} is shipped to the browser`,
        message:
          `${name} uses a public prefix, so its value is embedded in the client bundle` +
          (info.valueKind ? ` (and the value is ${/^[AEIOU]/i.test(info.valueKind) ? 'an' : 'a'} ${info.valueKind})` : '') +
          `. Seen ${plural(info.uses, 'time')}.`,
        file: info.file,
        line: info.line,
        snippet: info.snippet,
      });
    }
    return out;
  },
});

export const serverSecretInClientRule = defineRule({
  id: 'secrets/server-env-in-client',
  title: 'Server-only env var read in browser code',
  category: 'secrets',
  severity: 'high',
  why:
    'Bundlers only expose public-prefixed variables to the browser, so a server secret read in a client component is `undefined` at runtime. ' +
    'The feature silently breaks, and the usual "fix" (adding NEXT_PUBLIC_/VITE_) leaks the secret to every visitor.',
  fix:
    'Move the code that needs the secret to the server (route handler, server action, Supabase edge function) and call it from the client with fetch or a server action.',
  appliesTo: (ctx) => ctx.clientFiles().size > 0,
  run(ctx) {
    const out: FindingInput[] = [];
    const pagesPrefix = ctx.detection.pagesDir ? `${ctx.detection.pagesDir}/` : null;
    for (const file of [...ctx.clientFiles()].sort()) {
      const code = ctx.code(file);
      if (pagesPrefix && file.startsWith(pagesPrefix) && /\bget(ServerSideProps|StaticProps|StaticPaths)\b/.test(code)) continue;
      const original = ctx.read(file);
      const idx = new LineIndex(original);
      const seen = new Set<string>();
      for (const ref of envRefs(code, original)) {
        if (publicPrefixOf(ref.name) || !looksSecretEnvName(ref.name) || /SERVICE_?ROLE/i.test(ref.name)) continue;
        if (seen.has(ref.name)) continue;
        seen.add(ref.name);
        const chain = ctx.clientChain(file);
        out.push({
          title: `${ref.name} read in client code`,
          message:
            `${file} is bundled to the browser${chain.length > 1 ? ` (imported via ${chain.slice(1).join(' ← ')})` : ''}, ` +
            `but reads ${ref.name}, which is only available on the server.`,
          file,
          line: ref.line,
          snippet: snippetOf(idx.line(ref.line)),
        });
      }
    }
    return out;
  },
});

export const secretRules = [hardcodedSecretRule, envFileCommittedRule, publicEnvSecretRule, serverSecretInClientRule];
export type { ProjectContext };
