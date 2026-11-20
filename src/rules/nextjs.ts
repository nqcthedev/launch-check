import type { FindingInput, ProjectContext } from '../types.js';
import { LineIndex, hasDirective, maskSource, matchBracket, snippetOf } from '../utils/text.js';
import { defineRule, isNext, matchAll, middlewareFiles, nextConfigFiles } from './helpers.js';

function configText(ctx: ProjectContext): { file: string; code: string; original: string } | null {
  const file = nextConfigFiles(ctx)[0];
  if (!file) return null;
  return { file, code: ctx.code(file), original: ctx.read(file) };
}

export const buildChecksDisabledRule = defineRule({
  id: 'nextjs/build-checks-disabled',
  title: 'Type checking or linting disabled during build',
  category: 'nextjs',
  severity: 'high',
  why:
    '`ignoreBuildErrors` lets a build with type errors deploy, so bugs the compiler already found reach production. ' +
    'AI tools switch it on to get a red build to go green.',
  fix: 'Remove `typescript.ignoreBuildErrors` / `eslint.ignoreDuringBuilds` and fix the reported errors (run `npx tsc --noEmit`).',
  appliesTo: isNext,
  run(ctx) {
    const cfg = configText(ctx);
    if (!cfg) return [];
    const out: FindingInput[] = [];
    for (const m of matchAll(cfg.original, cfg.code, /\bignoreBuildErrors\s*:\s*true\b/g)) {
      out.push({
        title: 'TypeScript errors are ignored during `next build`',
        message: `${cfg.file} sets typescript.ignoreBuildErrors: true, so type errors never block a deploy.`,
        file: cfg.file,
        line: m.line,
        snippet: m.snippet,
      });
    }
    for (const m of matchAll(cfg.original, cfg.code, /\bignoreDuringBuilds\s*:\s*true\b/g)) {
      out.push({
        severity: 'low',
        title: 'ESLint is skipped during `next build`',
        message: `${cfg.file} sets eslint.ignoreDuringBuilds: true. Make sure lint runs in CI instead.`,
        file: cfg.file,
        line: m.line,
        snippet: m.snippet,
      });
    }
    return out;
  },
});

export const imagesUnoptimizedRule = defineRule({
  id: 'nextjs/images-unoptimized',
  title: 'Image optimization disabled',
  category: 'nextjs',
  severity: 'low',
  why:
    '`images.unoptimized: true` serves original, full-size images to every device: slower Largest Contentful Paint, worse SEO, higher bandwidth bills. ' +
    'It is often copied from static-export examples.',
  fix: 'Remove `unoptimized: true` and configure `images.remotePatterns` for external hosts. Keep it only with `output: "export"`.',
  appliesTo: isNext,
  run(ctx) {
    const cfg = configText(ctx);
    if (!cfg) return [];
    if (/\boutput\s*:\s*['"]export['"]/.test(cfg.code)) return [];
    return matchAll(cfg.original, cfg.code, /\bunoptimized\s*:\s*true\b/g).map((m) => ({
      title: 'next/image optimization is turned off',
      message: `${cfg.file} sets images.unoptimized: true for a server-rendered app.`,
      file: cfg.file,
      line: m.line,
      snippet: m.snippet,
    }));
  },
});

function anyFile(ctx: ProjectContext, dir: string, base: string): string | undefined {
  const re = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:.*/)?${base}\\.[jt]sx?$`);
  return ctx.files.find((f) => re.test(f.path))?.path;
}

export const missingErrorBoundaryRule = defineRule({
  id: 'nextjs/missing-error-boundary',
  title: 'No error boundary',
  category: 'nextjs',
  severity: 'low',
  why:
    'Without an error.tsx, an exception in any server or client component shows the bare Next.js crash screen (or a blank page) instead of a recoverable UI.',
  fix: 'Add app/error.tsx (a "use client" component with a reset button) and app/global-error.tsx for errors in the root layout.',
  appliesTo: isNext,
  run(ctx) {
    const { appDir, pagesDir } = ctx.detection;
    if (appDir && !anyFile(ctx, appDir, 'error') && !anyFile(ctx, appDir, 'global-error')) {
      return [{ title: 'App Router has no error.tsx', message: `No error.tsx or global-error.tsx under ${appDir}/.`, file: appDir }];
    }
    if (!appDir && pagesDir && !ctx.files.some((f) => new RegExp(`^${pagesDir}/_error\\.[jt]sx?$`).test(f.path))) {
      return [{ title: 'Pages Router has no custom _error page', message: `No ${pagesDir}/_error.tsx.`, file: pagesDir }];
    }
    return [];
  },
});

export const missingNotFoundRule = defineRule({
  id: 'nextjs/missing-not-found',
  title: 'No custom 404 page',
  category: 'nextjs',
  severity: 'low',
  why: 'The default 404 page has no navigation back into your app and no branding; broken links become dead ends.',
  fix: 'Add app/not-found.tsx (App Router) or pages/404.tsx (Pages Router) with a link home.',
  appliesTo: isNext,
  run(ctx) {
    const { appDir, pagesDir } = ctx.detection;
    if (appDir && !ctx.files.some((f) => new RegExp(`^${appDir}/not-found\\.[jt]sx?$`).test(f.path))) {
      return [{ title: 'App Router has no not-found.tsx', message: `No ${appDir}/not-found.tsx.`, file: appDir }];
    }
    if (!appDir && pagesDir && !ctx.files.some((f) => new RegExp(`^${pagesDir}/404\\.[jt]sx?$`).test(f.path))) {
      return [{ title: 'Pages Router has no 404 page', message: `No ${pagesDir}/404.tsx.`, file: pagesDir }];
    }
    return [];
  },
});

/** Packages that must never be imported from browser code. */
const SERVER_ONLY_PACKAGES: Array<{ re: RegExp; reason: string }> = [
  { re: /^server-only$/, reason: 'a module marked server-only' },
  { re: /^(node:.*|fs|fs\/promises|child_process|net|tls|dgram|cluster|worker_threads|http2|zlib|v8|vm)$/, reason: 'a Node.js built-in that does not exist in the browser' },
  { re: /^next\/headers$/, reason: 'only works in server components and route handlers' },
  { re: /^(@prisma\/client|prisma|pg|postgres|mysql2|mongodb|mongoose|ioredis|redis|better-sqlite3|@neondatabase\/serverless|@planetscale\/database)$/, reason: 'a database driver; using it in the browser means shipping database credentials' },
  { re: /^drizzle-orm\/(node-postgres|postgres-js|mysql2|neon-http|neon-serverless|better-sqlite3|libsql)$/, reason: 'a database driver; using it in the browser means shipping database credentials' },
  { re: /^(stripe)$/, reason: 'the Stripe Node SDK, which needs your secret key; use @stripe/stripe-js in the browser' },
  { re: /^(firebase-admin|firebase-admin\/.*)$/, reason: 'the Firebase Admin SDK, which needs a service account' },
  { re: /^(nodemailer|resend|@sendgrid\/mail|postmark|twilio)$/, reason: 'a server-side email/SMS SDK that needs an API key' },
  { re: /^(jsonwebtoken|bcrypt)$/, reason: 'a Node.js crypto library; signing secrets do not belong in the browser' },
  { re: /^(openai|@anthropic-ai\/sdk|groq-sdk|@google\/generative-ai|@google\/genai|@mistralai\/mistralai|replicate)$/, reason: 'an LLM SDK; calling it from the browser means shipping your API key' },
];

export const serverModuleInClientRule = defineRule({
  id: 'security/server-module-in-client',
  title: 'Server-only module imported into browser code',
  category: 'security',
  severity: 'high',
  why:
    'Everything a client component imports is bundled for the browser. Server SDKs either break the build, or "work" by shipping the credentials they need ' +
    'to every visitor (LLM SDKs with `dangerouslyAllowBrowser`, database clients, Stripe secret keys).',
  fix:
    'Keep server SDKs in modules that start with `import "server-only"` and expose what the UI needs through a route handler or server action. ' +
    'In the browser use the public SDKs (@stripe/stripe-js, Supabase anon client).',
  appliesTo: (ctx) => ctx.clientFiles().size > 0,
  run(ctx) {
    const out: FindingInput[] = [];
    const client = ctx.clientFiles();
    for (const file of [...client].sort()) {
      const original = ctx.read(file);
      const code = ctx.code(file);
      const idx = new LineIndex(original);
      const re = /\b(?:import\s+(?!type\b)(?:[\w$*{}\s,]+?\s+from\s*)?|export\s+(?!type\b)[\w$*{}\s,]+?\s+from\s*|require\(\s*|import\(\s*)(['"])([^'"\n]+)\1/g;
      for (const m of code.matchAll(re)) {
        const spec = m[2]!;
        const hit = SERVER_ONLY_PACKAGES.find((p) => p.re.test(spec));
        if (!hit) continue;
        const line = idx.lineOf(m.index ?? 0);
        const chain = ctx.clientChain(file);
        const allowBrowser = /dangerouslyAllowBrowser\s*:\s*true/.test(code);
        out.push({
          // Built-ins and next/headers break the build; SDKs leak credentials.
          severity: /built-in|only works/.test(hit.reason) ? 'medium' : 'high',
          title: `Client bundle imports "${spec}"`,
          message:
            `${file} is browser code${chain.length > 1 ? ` (imported via ${chain.slice(1).join(' ← ')})` : ' ("use client")'} and imports "${spec}" (${hit.reason}).` +
            (allowBrowser ? ' The file also sets `dangerouslyAllowBrowser: true`.' : ''),
          file,
          line,
          snippet: snippetOf(idx.line(line)),
        });
      }
    }
    return out;
  },
});

export const dangerousHtmlRule = defineRule({
  id: 'security/dangerously-set-inner-html',
  title: 'dangerouslySetInnerHTML with dynamic content',
  category: 'security',
  severity: 'high',
  why:
    'Rendering user-controlled or AI-generated HTML lets an attacker inject `<script>` tags or event handlers that run as your users (stored XSS): ' +
    'stealing sessions, Supabase tokens from localStorage, or acting on their behalf.',
  fix:
    'Render as text instead, or sanitize first: `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}` (isomorphic-dompurify on the server). ' +
    'For Markdown use react-markdown without rehype-raw.',
  run(ctx) {
    const out: FindingInput[] = [];
    for (const file of ctx.sourceFiles()) {
      if (!/\.[jt]sx$|\.js$/.test(file.path)) continue;
      const code = ctx.code(file.path);
      if (!code.includes('dangerouslySetInnerHTML')) continue;
      const original = ctx.read(file.path);
      const structural = maskSource(original, { comments: true, strings: true });
      const idx = new LineIndex(original);
      for (const m of code.matchAll(/dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*/g)) {
        const exprStart = (m.index ?? 0) + m[0].length;
        const outer = code.indexOf('{', m.index ?? 0);
        const outerEnd = matchBracket(structural, outer);
        const innerOpen = structural.indexOf('{', outer + 1);
        const innerEnd = matchBracket(structural, innerOpen);
        const end = innerEnd > 0 && innerEnd < outerEnd ? innerEnd : outerEnd;
        const expr = original.slice(exprStart, end > exprStart ? end : exprStart + 80).trim().replace(/,\s*$/, '');
        if (/^(['"])[^'"]*\1$/.test(expr) || /^`[^`$]*`$/.test(expr)) continue;
        if (/\b(DOMPurify\.sanitize|sanitize(Html)?|purify|xss|escapeHtml|sanitizeHtml)\s*\(/i.test(expr)) continue;
        if (/^JSON\.stringify\(/.test(expr)) continue; // JSON-LD; see README limitations
        // <style> cannot run script (the stock shadcn/ui chart.tsx builds its theme CSS this way), and a
        // <script type="application/ld+json"> block is data, not code.
        const tagStart = structural.lastIndexOf('<', m.index ?? 0);
        const openTag = tagStart === -1 ? '' : original.slice(tagStart, Math.min(original.length, (end > 0 ? end : exprStart) + 200));
        if (/^<style\b/.test(openTag)) continue;
        if (/^<script\b/i.test(openTag) && /application\/ld\+json/.test(openTag)) continue;
        const line = idx.lineOf(m.index ?? 0);
        out.push({
          title: 'Unsanitized HTML passed to dangerouslySetInnerHTML',
          message: `dangerouslySetInnerHTML renders \`${expr.length > 60 ? `${expr.slice(0, 57)}...` : expr}\` without sanitization.`,
          file: file.path,
          line,
          snippet: snippetOf(idx.line(line)),
        });
      }
    }
    return out;
  },
});

/* ---------------------------------------------------------------------------------------------- */
/* Unauthenticated route handlers / API routes / server actions (heuristic)                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Given structural (comment+string masked) source and the index of a function declaration / const arrow,
 * return the [start, end] offsets of its body.
 */
export function functionBody(structural: string, at: number): [number, number] {
  // `export const POST = withAuth(async (req) => {...})`: the handler is the whole call, wrapper name included.
  const decl = /^export\s+(?:default\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*/.exec(structural.slice(at, at + 400));
  if (decl) {
    const exprStart = at + decl[0].length;
    const head = structural.slice(exprStart, exprStart + 200);
    const call = /^(?:await\s+)?[\w$.]+\s*\(/.exec(head);
    if (call && !/^(?:async|function)\b/.test(head)) {
      const close = matchBracket(structural, exprStart + call[0].length - 1);
      return [at, close === -1 ? structural.length : close + 1];
    }
  }
  const paren = structural.indexOf('(', at);
  if (paren === -1) return [at, structural.length];
  const closeParen = matchBracket(structural, paren);
  if (closeParen === -1) return [at, structural.length];
  // Walk past a return type annotation (`): Promise<{ ok: boolean }> {`) to the brace that opens the body.
  let angle = 0;
  for (let i = closeParen + 1; i < structural.length; i++) {
    const ch = structural[i];
    if (ch === '<') angle++;
    else if (ch === '>' && structural[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (ch === '=' && structural[i + 1] === '>' && angle === 0) {
      const rest = /^\s*/.exec(structural.slice(i + 2))![0].length + i + 2;
      if (structural[rest] === '{') {
        const end = matchBracket(structural, rest);
        return [at, end === -1 ? structural.length : end + 1];
      }
      const end = structural.indexOf('\n', i);
      return [at, end === -1 ? structural.length : end];
    } else if (ch === '{') {
      const before = structural.slice(closeParen, i).trimEnd().slice(-1);
      if (angle > 0 || before === ':' || before === '|' || before === '&') {
        const skip = matchBracket(structural, i); // object type literal inside the annotation
        if (skip === -1) return [at, structural.length];
        i = skip;
        continue;
      }
      const end = matchBracket(structural, i);
      return [at, end === -1 ? structural.length : end + 1];
    } else if (ch === ';' && angle === 0) {
      return [at, i]; // overload signature / declaration without a body
    }
  }
  return [at, structural.length];
}

/**
 * Evidence that a handler identifies or authorizes its caller. Deliberately generous: project-specific helpers
 * (requireManagementAuth, checkAdminAuth, withProfileAuth, hasPermission, requireUserId, getCurrentUser) count,
 * because a missed finding is cheaper than telling someone their guarded endpoint is open.
 */
export const AUTH_SIGNAL_RE = new RegExp(
  [
    String.raw`\bauth\s*\(\s*\)|\bauth\.protect\s*\(`,
    String.raw`\b(?:getServerSession|getSession|getUser|getClaims|currentUser|withAuth|withApiAuthRequired|isAuthenticated|verifyToken|verifyJwt|verifyIdToken|jwtVerify|jwt\.verify|validateRequest|getToken|getAuth|clerkClient|getKindeServerSession|authorize|unauthori[sz]ed|forbidden|protectedProcedure|adminProcedure)\b`,
    String.raw`\b[\w$]*auth(?!or)[\w$]*\s*\(`, // requireManagementAuth(), checkAdminAuth(), authenticateRequest(), withProfileAuth()
    String.raw`\b[\w$]*permission[\w$]*\s*\(`,
    String.raw`\b(?:require|ensure|assert)[A-Z][\w$]*\s*\(`, // requireUserId(), ensureAdmin(), assertOwner()
    String.raw`\b(?:check|verify|validate|has|is|api|only|with)[\w$]*(?:Admin|Role|Access|Session|Token|Owner|Ownership|Member|Membership|LoggedIn|SignedIn)[\w$]*\s*\(`, // apiAdmin(), isAdmin()
    String.raw`\b[\w$]*(?:guard|gate)\s*\(`,
    String.raw`\bget(?:Current|Session|Logged\w*|Signed\w*|Active)(?:User|Session|Viewer|Actor|Member|Profile|Account)[\w$]*\s*\(`,
    String.raw`\bgetUserId\s*\(\s*\)`,
    String.raw`\b(?:401|403)\b|['"]authorization['"]|headers\.authorization|x-api-key`,
    String.raw`\b(?:CRON|ADMIN|INTERNAL)_(?:API_)?(?:SECRET|TOKEN|KEY)\b|\bAPI_SECRET\b`,
  ].join('|'),
  'i',
);

/** Endpoints that have to be callable without a session: sign-in, sign-up, OAuth callbacks, password reset. */
const PUBLIC_AUTH_URL_RE =
  /\/(?:auth|login|log-in|signin|sign-in|signup|sign-up|register|logout|log-out|signout|sign-out|callback|forgot-password|reset-password|verify-email|confirm|otp|magic-link|oauth)(?:\/|$)/i;
const PUBLIC_INGEST_URL_RE = /\/(?:csp-report|report-uri|csp|health|healthz|ping|status|telemetry|analytics|track|beacon|vitals)(?:\/|$)/i;
const PUBLIC_AUTH_CALL_RE =
  /\.auth\.(?:signUp|signInWith\w+|signOut|resetPasswordForEmail|verifyOtp|exchangeCodeForSession)\s*\(|\b(?:signIn|signUp|signOut|createUserWithEmailAndPassword|signInWithEmailAndPassword)\s*\(/;

const SIGNATURE_SIGNAL_RE =
  /\b(constructEvent(Async)?|webhooks\.verify|Webhook\s*\(|svix|timingSafeEqual|createHmac|hmac|CRON_SECRET)\b|[\w$]*verif[\w$]*\s*\(|[\w$]*signature[\w$]*\s*\(|\b\w*(?:WEBHOOK|SIGNING)_(?:SECRET|TOKEN|KEY)\b|secret[-_]token|['"`](?:x-)?[\w-]*(?:signature|hmac|webhook-secret)[\w-]*['"`]|stripe-signature/i;

const DB_WRITE_RE =
  /\.(delete|insert|update|upsert|remove|destroy|updateMany|deleteMany|createMany|\$executeRaw|\$executeRawUnsafe)\s*\(|\b(prisma|db|tx)\.\w+\.create\s*\(|\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/;

const PRIVILEGED_RE =
  /\b(service_?role|SERVICE_?ROLE|supabaseAdmin|adminClient|createAdminClient|prisma|drizzle|firebase-admin|adminDb|stripe|openai|anthropic)\.\w+/;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface MiddlewareCoverage {
  file: string;
  covers: (urlPath: string) => boolean;
}

function middlewareCoverage(ctx: ProjectContext): MiddlewareCoverage | null {
  const file = middlewareFiles(ctx)[0];
  if (!file) return null;
  const code = ctx.code(file);
  if (!AUTH_SIGNAL_RE.test(code) && !/redirect\(|NextResponse\.redirect/.test(code)) return null;
  // Auth middleware without a redirect / 401 path does not protect anything.
  if (!/(redirect|401|403|unauthori[sz]ed)/i.test(code)) return null;
  const matcherBlock = /matcher\s*:\s*(\[[\s\S]*?\]|['"][^'"]+['"])/.exec(code)?.[1];
  if (!matcherBlock) return { file, covers: () => true };
  const patterns = [...matcherBlock.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  return {
    file,
    covers: (urlPath) =>
      patterns.some((p) => {
        if (p.includes('(?!')) {
          const excluded = /\(\?!([^)]*)\)/.exec(p)?.[1]?.split('|') ?? [];
          const seg = urlPath.replace(/^\//, '');
          return !excluded.some((e) => e && seg.startsWith(e.replace(/\\/g, '')));
        }
        const prefix = p.replace(/\/:path\*.*$/, '').replace(/\/:\w+[*+?]?.*$/, '').replace(/\(.*$/, '');
        return urlPath === prefix || urlPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || prefix === '' || prefix === '/';
      }),
  };
}

function routeUrl(path: string, baseDir: string): string {
  let rel = path.slice(baseDir.length).replace(/\/(route|index)\.[jt]sx?$/, '').replace(/\.[jt]sx?$/, '');
  rel = rel.replace(/\/\([^)]+\)/g, ''); // route groups
  return rel === '' ? '/' : rel;
}

/** Paths that receive provider webhooks. `src/hooks/useThing.ts` (React hooks) is not one of them. */
function isWebhookPath(p: string): boolean {
  return /webhook/i.test(p) || /(^|\/)api\/(?:.*\/)?hooks?\//i.test(p);
}

/** Server-side request handlers, as opposed to components or pages that merely have "webhook" in their name. */
function isHandlerFile(p: string): boolean {
  if (/\.[jt]sx$/.test(p)) return false;
  return /(^|\/)route\.[cm]?[jt]s$/.test(p) || /(^|\/)(pages\/api|api|functions|server|routes|controllers|handlers)\//.test(p);
}

export const unauthenticatedRouteRule = defineRule({
  id: 'security/unauthenticated-route',
  title: 'API endpoint with no visible auth check',
  category: 'security',
  severity: 'high',
  heuristic: true,
  why:
    'Route handlers, API routes and server actions are public HTTP endpoints: anyone can call them with curl, regardless of what the UI shows. ' +
    'An endpoint that writes data or uses a privileged client (service role, Prisma, Stripe, OpenAI) without verifying the caller is an open door, ' +
    'and an open LLM endpoint can burn your API budget overnight.',
  fix:
    'At the top of the handler, resolve the user (e.g. `const { data: { user } } = await supabase.auth.getUser()`, `await auth()`) and return 401 if missing; ' +
    'then authorize the specific resource (does this user own row X?). Do not rely on middleware alone.',
  appliesTo: isNext,
  run(ctx) {
    const out: FindingInput[] = [];
    const mw = middlewareCoverage(ctx);
    const { appDir, pagesDir } = ctx.detection;

    const consider = (file: string, url: string, kind: 'route' | 'api' | 'action', exportName: string, line: number, body: string) => {
      if (AUTH_SIGNAL_RE.test(body)) return;
      // Sign-in / sign-up / password-reset endpoints have to work without a session (for actions, judge by the file path).
      if (PUBLIC_AUTH_URL_RE.test(kind === 'action' ? `/${file.replace(/\/[^/]+$/, '').replace(/\([^)]+\)\//g, '')}/` : url)) return;
      // `export async function POST(req) { return GET(req) }`: the other handler decides, and it is judged on its own.
      if (/\breturn\s+(?:await\s+)?(?:GET|POST|PUT|PATCH|DELETE)\s*\(/.test(body)) return;
      // Nothing awaited means nothing was read or written: a stub or a static response.
      if (kind === 'route' && !/\bawait\b|\.then\s*\(/.test(body)) return;
      if (PUBLIC_AUTH_CALL_RE.test(body)) return;
      const privileged = PRIVILEGED_RE.test(body);
      // Every export of a "use server" file is an endpoint, but one that neither writes nor touches a privileged
      // client (a formatter, a read through the caller's own RLS-bound client) is not worth a finding.
      const writes = DB_WRITE_RE.test(body);
      const mutating = kind === 'action' ? writes : MUTATING_METHODS.has(exportName) || writes;
      if (!mutating && !privileged) return;
      // Browsers and beacons post to these without credentials by design.
      if (!writes && !privileged && PUBLIC_INGEST_URL_RE.test(url)) return;
      // Middleware-only auth is fragile (matchers drift; CVE-2025-29927 bypassed it entirely): report it, but as low.
      const onlyMiddleware = kind !== 'action' && mw?.covers(url) === true;
      const original = ctx.read(file);
      const idx = new LineIndex(original);
      const label =
        kind === 'action' ? `Server action ${exportName}()` : kind === 'api' ? `API route ${url}` : `Route handler ${exportName} ${url}`;
      const priv = PRIVILEGED_RE.exec(body)?.[0];
      const does = DB_WRITE_RE.test(body)
        ? 'writes to the database'
        : priv
          ? `calls \`${priv}\` (a privileged or paid API)`
          : `accepts ${kind === 'action' ? 'form submissions' : `${exportName} requests`}`;
      out.push({
        // High needs evidence of impact: a database write, or a privileged/paid client behind a mutating method.
        // "Accepts POST with no visible check" alone is a prompt to review, not a proven hole.
        severity: onlyMiddleware ? 'low' : writes || (privileged && mutating) ? 'high' : 'medium',
        title: onlyMiddleware ? `${label} relies on middleware for auth` : `${label} has no auth check`,
        message: onlyMiddleware
          ? `${label} ${does} and has no auth check of its own; it depends entirely on ${mw!.file}.`
          : `${label} ${does} but no authentication or authorization check was found in the handler` +
            `${kind === 'action' ? ' (server actions are callable by anyone who can load the page)' : ''}.`,
        file,
        line,
        snippet: snippetOf(idx.line(line)),
      });
    };

    for (const f of ctx.sourceFiles()) {
      const p = f.path;
      if (isWebhookPath(p)) continue; // handled by security/unverified-webhook
      const code = ctx.code(p);
      const original = ctx.read(p);
      const structural = maskSource(original, { comments: true, strings: true });
      const idx = new LineIndex(original);

      if (appDir && p.startsWith(`${appDir}/`) && /\/route\.[jt]s$/.test(p)) {
        const url = routeUrl(p, appDir);
        for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/g)) {
          const at = m.index ?? 0;
          const [start, end] = functionBody(structural, at);
          const body = code.slice(start, end);
          // Only the handler body counts: a helper such as requireUser() must actually be called by it.
          consider(p, url, 'route', m[1]!, idx.lineOf(at), body);
        }
      } else if (pagesDir && p.startsWith(`${pagesDir}/api/`)) {
        const url = routeUrl(p, pagesDir);
        const m = /export\s+default\s+(?:async\s+)?(?:function\b|\(|\w+)/.exec(code);
        if (m) consider(p, url, 'api', 'handler', idx.lineOf(m.index), code);
      } else if (hasDirective(original, 'use server')) {
        for (const m of code.matchAll(/export\s+(?:async\s+function\s+|const\s+)([\w$]+)/g)) {
          const at = m.index ?? 0;
          const [start, end] = functionBody(structural, at);
          const body = code.slice(start, end);
          // `export const prompt = ai.definePrompt({...})` or a config object is not a server action.
          if (/^export\s+const\b/.test(m[0]) && !/=>|\bfunction\b/.test(structural.slice(start, end))) continue;
          consider(p, '', 'action', m[1]!, idx.lineOf(at), body);
        }
      }
    }
    return out;
  },
});

export const unverifiedWebhookRule = defineRule({
  id: 'security/unverified-webhook',
  title: 'Webhook endpoint without signature verification',
  category: 'security',
  severity: 'high',
  heuristic: true,
  why:
    'Webhook URLs are public. If the handler trusts the request body without verifying the provider signature, anyone can POST a fake ' +
    '"checkout.session.completed" and unlock paid features or credit accounts for free.',
  fix:
    'Verify the signature with the raw body before parsing: for Stripe, `stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)`. ' +
    'For other providers use their SDK verifier (svix, @octokit/webhooks) or an HMAC with timingSafeEqual.',
  run(ctx) {
    const out: FindingInput[] = [];
    for (const f of ctx.sourceFiles()) {
      if (/\.[jt]sx$/.test(f.path)) continue; // components and pages do not receive webhooks
      const code = ctx.code(f.path);
      const isWebhook =
        isWebhookPath(f.path) &&
        isHandlerFile(f.path) &&
        /export\s+(?:async\s+)?(?:function|const)\s+POST\b|export\s+default\b|\.post\s*\(|\bserve\s*\(/.test(code);
      const stripeEvents = /['"](checkout\.session\.completed|invoice\.paid|customer\.subscription\.\w+|payment_intent\.succeeded)['"]/.test(code);
      if (!isWebhook && !stripeEvents) continue;
      // Stripe event names outside a webhook path only count in a file that is itself a request handler
      // (not a seed script or an end-to-end test helper that builds fake events).
      if (!isWebhook && !(isHandlerFile(f.path) && /\b(req|request)\b/.test(code)) ) continue;
      if (/(^|\/)(scripts?|tools|bin|seed|e2e)\//.test(f.path)) continue;
      if (SIGNATURE_SIGNAL_RE.test(code)) continue;
      // A handler that authenticates its caller is a management endpoint (create/rotate/retry a webhook),
      // or a receiver protected by a bearer secret. Either way it does not trust anonymous requests.
      if (AUTH_SIGNAL_RE.test(code)) continue;
      // A stub that awaits nothing processes nothing (e.g. "moved to /functions/v1/stripe-webhook").
      if (!/\bawait\b|\.then\s*\(/.test(code)) continue;
      const original = ctx.read(f.path);
      const lineMatch = matchAll(original, code, /export\s+(?:async\s+)?(?:function|const)\s+POST\b|export\s+default\b|['"]checkout\.session\.completed['"]/g)[0];
      out.push({
        severity: stripeEvents ? 'critical' : 'high',
        title: 'Webhook trusts unsigned requests',
        message: `${f.path} handles webhook events${stripeEvents ? ' (Stripe payment events)' : ''} but never verifies the provider signature.`,
        file: f.path,
        ...(lineMatch ? { line: lineMatch.line, snippet: lineMatch.snippet } : {}),
      });
    }
    return out;
  },
});

export const nextRules = [
  buildChecksDisabledRule,
  imagesUnoptimizedRule,
  missingErrorBoundaryRule,
  missingNotFoundRule,
  serverModuleInClientRule,
  dangerousHtmlRule,
  unauthenticatedRouteRule,
  unverifiedWebhookRule,
];
