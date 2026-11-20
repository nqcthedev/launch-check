# Production Readiness Report: taskpilot

| | |
|---|---|
| **Date** | 2026-01-15 |
| **Stack** | Next.js 14.1.0 (App Router) · Supabase, Stripe, OpenAI |
| **Score** | **13/100 (grade F)** |
| **Verdict** | Not ready for production |

## Summary

**Not ready for production.** 8 critical issues can be exploited by anyone on the internet today and must be fixed before launch.

| Severity | Findings | What it means |
|---|---:|---|
| Critical | 8 | Exploitable now: exposes data, credentials or money. Fix before anything else. |
| High | 12 | Serious risk or broken behaviour. Fix before launch. |
| Medium | 8 | Weakens security or reliability. Fix soon after launch. |
| Low | 9 | Hardening, SEO and maintainability. |
| Info | 0 | For awareness; no score impact. |

## Top priorities

1. **.env with live secrets is not gitignored** (Critical) in `.env:4`
2. **Stripe live secret key hard-coded in source** (Critical) in `lib/stripe.ts:3`
3. **NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is shipped to the browser** (Critical) in `.env:4`
4. **NEXT_PUBLIC_OPENAI_API_KEY is shipped to the browser** (Critical) in `.env:5`
5. **Table "todos" has Row Level Security disabled** (Critical) in `supabase/migrations/20240115120000_init.sql:17`
6. **Supabase service_role key used in browser code** (Critical) in `lib/supabase.ts:5`
7. **Webhook trusts unsigned requests** (Critical) in `app/api/webhooks/stripe/route.ts:4`

## Findings

### Critical (8)

#### 1. .env with live secrets is not gitignored

**Severity:** Critical · **Category:** Secrets & credentials · **Check:** `secrets/env-file-committed`

**Location:** `.env:4`

.env is not covered by .gitignore, so the next `git add .` commits it. It contains 3 secret-looking values: NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_OPENAI_API_KEY, STRIPE_SECRET_KEY.

```dotenv
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=********
```

**Why it matters:** .env files hold production credentials. If one is committed, every collaborator, CI log, fork and (for public repos) the whole internet gets your keys. AI builders often create .env and a .gitignore that only covers .env.local.

**How to fix:** Add `.env*` (and `!.env.example`) to .gitignore, run `git rm --cached <file>`, rotate every secret that was in it, and keep only placeholder values in a committed .env.example.

#### 2. Stripe live secret key hard-coded in source

**Severity:** Critical · **Category:** Secrets & credentials · **Check:** `secrets/hardcoded-key`

**Location:** `lib/stripe.ts:3`

Found Stripe live secret key (sk_live_******…(49 chars)) in a file that is bundled into the browser JavaScript. Clerk secret keys share this prefix.

```ts
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_live_******…(49 chars)', {
```

**Why it matters:** Anything committed to the repository is readable by everyone with access to it, forever (git history keeps it even after deletion). Leaked API keys are scraped from public repos within minutes and used for fraud, data theft, or to run up your bill.

**How to fix:** Rotate the key in the provider dashboard first (assume it is compromised), then move it to an environment variable that is only read on the server (Vercel/Netlify project settings, or a gitignored .env.local), and purge it from git history if the repo was ever public.

#### 3. NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is shipped to the browser

**Severity:** Critical · **Category:** Secrets & credentials · **Check:** `secrets/public-env-secret`

**Location:** `.env:4`

NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY uses a public prefix, so its value is embedded in the client bundle (and the value is a Supabase service_role key). Seen 2 times.

```dotenv
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=********
```

**Why it matters:** Variables prefixed NEXT_PUBLIC_, VITE_, REACT_APP_ or EXPO_PUBLIC_ are inlined into the JavaScript sent to every visitor at build time. Anyone can open DevTools and copy them. AI tools add the prefix to "fix" an undefined variable in a client component.

**How to fix:** Remove the public prefix, read the variable only in server code (route handler, server action, edge function), and call that from the browser. Rotate the key: it has already been shipped to browsers.

#### 4. NEXT_PUBLIC_OPENAI_API_KEY is shipped to the browser

**Severity:** Critical · **Category:** Secrets & credentials · **Check:** `secrets/public-env-secret`

**Location:** `.env:5`

NEXT_PUBLIC_OPENAI_API_KEY uses a public prefix, so its value is embedded in the client bundle (and the value is an OpenAI API key). Seen 2 times.

```dotenv
NEXT_PUBLIC_OPENAI_API_KEY=********
```

**Why it matters:** Variables prefixed NEXT_PUBLIC_, VITE_, REACT_APP_ or EXPO_PUBLIC_ are inlined into the JavaScript sent to every visitor at build time. Anyone can open DevTools and copy them. AI tools add the prefix to "fix" an undefined variable in a client component.

**How to fix:** Remove the public prefix, read the variable only in server code (route handler, server action, edge function), and call that from the browser. Rotate the key: it has already been shipped to browsers.

#### 5. Table "todos" has Row Level Security disabled

**Severity:** Critical · **Category:** Supabase · **Check:** `supabase/rls-disabled`

**Location:** `supabase/migrations/20240115120000_init.sql:17`

public.todos is created without `enable row level security` in any migration; the table is readable and writable with the public anon key.

```sql
create table public.todos (
```

**Why it matters:** Supabase exposes every table in the public schema through its REST API. The anon key ships in your frontend, so without RLS anyone can read, modify or delete every row with a single curl command. This is the most common breach in AI-built apps.

**How to fix:** Add `alter table <name> enable row level security;` in a new migration, then write policies scoped to the owner, e.g. `create policy "own rows" on <name> for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`.

#### 6. Supabase service_role key used in browser code

**Severity:** Critical · **Category:** Supabase · **Check:** `supabase/service-role-in-client`

**Location:** `lib/supabase.ts:5`

lib/supabase.ts is part of the browser bundle (imported via app/dashboard/page.tsx) and reads NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY.

```ts
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!;
```

**Why it matters:** The service_role key bypasses every RLS policy. Any module that reaches the browser bundle exposes it (or, if the env var is not public, the code is broken and someone will "fix" it by making it public). This is full admin access to your database.

**How to fix:** Create the admin client in a server-only module (`import "server-only"` at the top of lib/supabase/admin.ts) and use it exclusively from route handlers / server actions after checking the user. In the browser use the anon key with RLS policies.

#### 7. Webhook trusts unsigned requests

**Severity:** Critical · **Category:** Application security · **Check:** `security/unverified-webhook` · **Heuristic:** yes, verify manually

**Location:** `app/api/webhooks/stripe/route.ts:4`

app/api/webhooks/stripe/route.ts handles webhook events (Stripe payment events) but never verifies the provider signature.

```ts
export async function POST(req: Request) {
```

**Why it matters:** Webhook URLs are public. If the handler trusts the request body without verifying the provider signature, anyone can POST a fake "checkout.session.completed" and unlock paid features or credit accounts for free.

**How to fix:** Verify the signature with the raw body before parsing: for Stripe, `stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)`. For other providers use their SDK verifier (svix, @octokit/webhooks) or an HMAC with timingSafeEqual.

#### 8. next 14.1.0 allows bypassing middleware.ts

**Severity:** Critical · **Category:** Dependencies · **Check:** `dependencies/next-middleware-bypass`

**Location:** `package.json:13`

next 14.1.0 is affected by CVE-2025-29927 (fixed in 14.2.25) and the project uses middleware.ts, which performs auth checks.

```json
"next": "14.1.0",
```

**Why it matters:** In affected Next.js versions an attacker can skip middleware entirely by sending an `x-middleware-subrequest` header. If middleware is where you check authentication, every "protected" page is public.

**How to fix:** Upgrade Next.js to 12.3.5, 13.5.9, 14.2.25, 15.2.3 or later, and re-check auth inside pages/route handlers instead of relying on middleware alone.

**Reference:** https://github.com/advisories/GHSA-f82v-jwr5-mffw

### High (12)

#### 9. STRIPE_SECRET_KEY read in client code

**Severity:** High · **Category:** Secrets & credentials · **Check:** `secrets/server-env-in-client`

**Location:** `lib/stripe.ts:3`

lib/stripe.ts is bundled to the browser (imported via components/UpgradeButton.tsx), but reads STRIPE_SECRET_KEY, which is only available on the server.

```ts
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_live_******…(49 chars)', {
```

**Why it matters:** Bundlers only expose public-prefixed variables to the browser, so a server secret read in a client component is `undefined` at runtime. The feature silently breaks, and the usual "fix" (adding NEXT_PUBLIC_/VITE_) leaks the secret to every visitor.

**How to fix:** Move the code that needs the secret to the server (route handler, server action, Supabase edge function) and call it from the client with fetch or a server action.

#### 10. Policy "Enable all access for all users" lets anyone with your public anon key write "notes"

**Severity:** High · **Category:** Supabase · **Check:** `supabase/permissive-policy`

**Location:** `supabase/migrations/20240115120000_init.sql:35`

Policy "Enable all access for all users" on public.notes (FOR ALL, TO public) uses `true`: anyone with your public anon key can read, insert, update and delete every row of notes.

```sql
create policy "Enable all access for all users"
```

**Why it matters:** A policy with `using (true)` or `with check (true)` turns RLS back off for that operation: it is equivalent to no protection. AI tools generate these to make "permission denied" errors go away.

**How to fix:** Scope the policy to the row owner, e.g. `using (auth.uid() = user_id)` and `with check (auth.uid() = user_id)`. Keep `true` only for SELECT on genuinely public data (e.g. published blog posts) and say so in a comment.

#### 11. CORS allows any origin together with credentials

**Severity:** High · **Category:** Application security · **Check:** `security/cors-wildcard-credentials`

**Location:** `app/api/chat/route.ts:5`

app/api/chat/route.ts allows any origin (`*`) and also sends Access-Control-Allow-Credentials: true.

```ts
'Access-Control-Allow-Origin': '*',
```

**Why it matters:** Allowing every origin (`*`, or reflecting the request Origin) while also allowing credentials lets any website make authenticated requests on behalf of your logged-in users and read the responses.

**How to fix:** Allow an explicit list of origins (`origin: ["https://app.example.com"]`) when credentials are needed, or drop credentials for public APIs.

#### 12. Unsanitized HTML passed to dangerouslySetInnerHTML

**Severity:** High · **Category:** Application security · **Check:** `security/dangerously-set-inner-html`

**Location:** `app/dashboard/page.tsx:59`

dangerouslySetInnerHTML renders `note.content` without sanitization.

```tsx
<div key={note.id} dangerouslySetInnerHTML={{ __html: note.content }} />
```

**Why it matters:** Rendering user-controlled or AI-generated HTML lets an attacker inject `<script>` tags or event handlers that run as your users (stored XSS): stealing sessions, Supabase tokens from localStorage, or acting on their behalf.

**How to fix:** Render as text instead, or sanitize first: `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}` (isomorphic-dompurify on the server). For Markdown use react-markdown without rehype-raw.

#### 13. eval() executes a string as code

**Severity:** High · **Category:** Application security · **Check:** `security/eval`

**Location:** `lib/ai-parse.ts:6`

lib/ai-parse.ts:6 uses eval().

```ts
return eval('(' + match[0] + ')');
```

**Why it matters:** `eval`, `new Function` and string-based `setTimeout` execute arbitrary strings as code. If any part of that string comes from a user, a URL, or an LLM response, it is remote code execution (on the server) or XSS (in the browser).

**How to fix:** Use `JSON.parse` for data (validate it with zod), a lookup table for dynamic dispatch, or a sandboxed expression parser (e.g. expr-eval) for formulas.

#### 14. Client bundle imports "openai"

**Severity:** High · **Category:** Application security · **Check:** `security/server-module-in-client`

**Location:** `lib/openai.ts:1`

lib/openai.ts is browser code (imported via components/ChatAssistant.tsx) and imports "openai" (an LLM SDK; calling it from the browser means shipping your API key). The file also sets `dangerouslyAllowBrowser: true`.

```ts
import OpenAI from 'openai';
```

**Why it matters:** Everything a client component imports is bundled for the browser. Server SDKs either break the build, or "work" by shipping the credentials they need to every visitor (LLM SDKs with `dangerouslyAllowBrowser`, database clients, Stripe secret keys).

**How to fix:** Keep server SDKs in modules that start with `import "server-only"` and expose what the UI needs through a route handler or server action. In the browser use the public SDKs (@stripe/stripe-js, Supabase anon client).

#### 15. Client bundle imports "stripe"

**Severity:** High · **Category:** Application security · **Check:** `security/server-module-in-client`

**Location:** `lib/stripe.ts:1`

lib/stripe.ts is browser code (imported via components/UpgradeButton.tsx) and imports "stripe" (the Stripe Node SDK, which needs your secret key; use @stripe/stripe-js in the browser).

```ts
import Stripe from 'stripe';
```

**Why it matters:** Everything a client component imports is bundled for the browser. Server SDKs either break the build, or "work" by shipping the credentials they need to every visitor (LLM SDKs with `dangerouslyAllowBrowser`, database clients, Stripe secret keys).

**How to fix:** Keep server SDKs in modules that start with `import "server-only"` and expose what the UI needs through a route handler or server action. In the browser use the public SDKs (@stripe/stripe-js, Supabase anon client).

#### 16. Route handler POST /api/chat has no auth check

**Severity:** High · **Category:** Application security · **Check:** `security/unauthenticated-route` · **Heuristic:** yes, verify manually

**Location:** `app/api/chat/route.ts:14`

Route handler POST /api/chat calls `openai.chat` (a privileged or paid API) but no authentication or authorization check was found in the handler.

```ts
export async function POST(req: Request) {
```

**Why it matters:** Route handlers, API routes and server actions are public HTTP endpoints: anyone can call them with curl, regardless of what the UI shows. An endpoint that writes data or uses a privileged client (service role, Prisma, Stripe, OpenAI) without verifying the caller is an open door, and an open LLM endpoint can burn your API budget overnight.

**How to fix:** At the top of the handler, resolve the user (e.g. `const { data: { user } } = await supabase.auth.getUser()`, `await auth()`) and return 401 if missing; then authorize the specific resource (does this user own row X?). Do not rely on middleware alone.

#### 17. Route handler DELETE /api/todos/[id] has no auth check

**Severity:** High · **Category:** Application security · **Check:** `security/unauthenticated-route` · **Heuristic:** yes, verify manually

**Location:** `app/api/todos/[id]/route.ts:5`

Route handler DELETE /api/todos/[id] writes to the database but no authentication or authorization check was found in the handler.

```ts
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
```

**Why it matters:** Route handlers, API routes and server actions are public HTTP endpoints: anyone can call them with curl, regardless of what the UI shows. An endpoint that writes data or uses a privileged client (service role, Prisma, Stripe, OpenAI) without verifying the caller is an open door, and an open LLM endpoint can burn your API budget overnight.

**How to fix:** At the top of the handler, resolve the user (e.g. `const { data: { user } } = await supabase.auth.getUser()`, `await auth()`) and return 401 if missing; then authorize the specific resource (does this user own row X?). Do not rely on middleware alone.

#### 18. Server action updateProfile() has no auth check

**Severity:** High · **Category:** Application security · **Check:** `security/unauthenticated-route` · **Heuristic:** yes, verify manually

**Location:** `app/dashboard/actions.ts:5`

Server action updateProfile() writes to the database but no authentication or authorization check was found in the handler (server actions are callable by anyone who can load the page).

```ts
export async function updateProfile(formData: FormData) {
```

**Why it matters:** Route handlers, API routes and server actions are public HTTP endpoints: anyone can call them with curl, regardless of what the UI shows. An endpoint that writes data or uses a privileged client (service role, Prisma, Stripe, OpenAI) without verifying the caller is an open door, and an open LLM endpoint can burn your API budget overnight.

**How to fix:** At the top of the handler, resolve the user (e.g. `const { data: { user } } = await supabase.auth.getUser()`, `await auth()`) and return 401 if missing; then authorize the specific resource (does this user own row X?). Do not rely on middleware alone.

#### 19. TypeScript errors are ignored during `next build`

**Severity:** High · **Category:** Next.js · **Check:** `nextjs/build-checks-disabled`

**Location:** `next.config.js:8`

next.config.js sets typescript.ignoreBuildErrors: true, so type errors never block a deploy.

```js
ignoreBuildErrors: true,
```

**Why it matters:** `ignoreBuildErrors` lets a build with type errors deploy, so bugs the compiler already found reach production. AI tools switch it on to get a red build to go green.

**How to fix:** Remove `typescript.ignoreBuildErrors` / `eslint.ignoreDuringBuilds` and fix the reported errors (run `npx tsc --noEmit`).

#### 20. react "^18.2.0" and react-dom "latest" do not match

**Severity:** High · **Category:** Dependencies · **Check:** `dependencies/react-version-mismatch`

**Location:** `package.json:16`

package.json declares react@"^18.2.0" but react-dom@"latest"; they can resolve to different versions.

```json
"react-dom": "latest",
```

**Why it matters:** react and react-dom must be the exact same version; a mismatch or two copies of React in the bundle cause "Invalid hook call" crashes and hydration errors that only show up in production builds.

**How to fix:** Install matching versions (`npm install react@X react-dom@X`), then `npm dedupe` and check `npm ls react`.

### Medium (8)

#### 21. No Content-Security-Policy header

**Severity:** Medium · **Category:** Application security · **Check:** `security/missing-csp`

**Location:** `next.config.js`

No Content-Security-Policy is set in the framework config, middleware, hosting config or HTML.

**Why it matters:** A Content-Security-Policy is the safety net when an XSS bug slips through: it stops injected scripts from loading or sending data to an attacker. Apps that render AI or user-generated content need it most.

**How to fix:** Start with a report-only policy and tighten it: `Content-Security-Policy: default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://<project>.supabase.co; frame-ancestors 'none'`. For Next.js with inline scripts, use the nonce-based middleware pattern from the Next.js CSP guide.

#### 22. 5 of 5 recommended security headers missing

**Severity:** Medium · **Category:** Application security · **Check:** `security/missing-security-headers`

**Location:** `next.config.js`

No configuration sets: Strict-Transport-Security (forces HTTPS); X-Frame-Options / frame-ancestors (prevents clickjacking); X-Content-Type-Options (stops MIME sniffing); Referrer-Policy (limits URL leakage to third parties); Permissions-Policy (disables unused browser features).

**Why it matters:** Baseline response headers block whole classes of attacks for free: clickjacking (your app framed on a phishing site), protocol downgrade, MIME sniffing. Security scanners and enterprise customers check for them first.

**How to fix:** Add an `async headers()` block to next.config (or `headers` in vercel.json / `_headers` on Netlify / `helmet()` in Express) that sets Strict-Transport-Security, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin and Permissions-Policy.

#### 23. No lockfile

**Severity:** Medium · **Category:** Dependencies · **Check:** `dependencies/missing-lockfile`

**Location:** `package.json`

package.json declares dependencies but no package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock is present.

**Why it matters:** Without a lockfile every install resolves fresh versions, so production can run different code than you tested, and a compromised or broken patch release ships automatically.

**How to fix:** Run your package manager once (`npm install`, `pnpm install`) and commit the generated lockfile; use `npm ci` / `pnpm install --frozen-lockfile` in CI and deploys.

#### 24. next 14.1.0 is 2 major versions behind

**Severity:** Medium · **Category:** Dependencies · **Check:** `dependencies/outdated-framework`

**Location:** `package.json:13`

next 14.1.0 is in use; the current major is 16.

```json
"next": "14.1.0",
```

**Why it matters:** Old majors stop receiving security patches, and every month behind makes the eventual upgrade larger. Security fixes for Next.js land only on recent majors.

**How to fix:** Upgrade one major at a time with the official codemods (`npx @next/codemod@latest upgrade`), running the build and tests between steps.

#### 25. 1 dependency not pinned

**Severity:** Medium · **Category:** Dependencies · **Check:** `dependencies/unpinned-version`

**Location:** `package.json:16`

react-dom@"latest".

```json
"react-dom": "latest",
```

**Why it matters:** "latest", "*" and ">=" ranges pull in new major versions with breaking changes on the next install, often in the middle of a deploy.

**How to fix:** Pin to a caret range of the version you tested (`npm install next@15.5.4` writes "^15.5.4").

#### 26. No .env.example

**Severity:** Medium · **Category:** Configuration · **Check:** `config/env-example`

**Location:** `lib/openai.ts:4`

The code reads 4 environment variables (NEXT_PUBLIC_OPENAI_API_KEY, STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) but there is no .env.example documenting them.

```ts
apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,
```

**Why it matters:** A deployment fails (or worse, runs with features silently disabled) when a variable the code needs is not set. .env.example is the checklist whoever deploys the app (you in six months, a client, Vercel) uses to configure it.

**How to fix:** Create or update .env.example with every variable the code reads, using placeholder values, and commit it.

#### 27. tsconfig.json: "strict" is not enabled

**Severity:** Medium · **Category:** Configuration · **Check:** `config/typescript-strict`

**Location:** `tsconfig.json:7`

tsconfig.json: "strict" is not enabled.

```json
"strict": false,
```

**Why it matters:** Without `strict`, TypeScript lets `null`/`undefined` flow anywhere and silently types unknown values as `any`. Most "Cannot read properties of undefined" crashes in production are errors strict mode would have caught at build time.

**How to fix:** Set `"strict": true` in tsconfig.json and fix the errors (`npx tsc --noEmit`). Enable it file-by-file with `// @ts-check` if the backlog is large.

#### 28. 8 explicit `any`s (30.4 per 1,000 lines)

**Severity:** Medium · **Category:** Code quality · **Check:** `code-quality/any-density`

**Location:** `app/dashboard/actions.ts:7` and 7 more

8 uses of `any` across 4 files; most in app/dashboard/page.tsx (4), components/ChatAssistant.tsx (2), app/dashboard/actions.ts (1).

```ts
const updates: any = Object.fromEntries(formData.entries());
```

<details><summary>All locations (8)</summary>

- `app/dashboard/actions.ts:7`
- `app/dashboard/page.tsx:10`
- `app/dashboard/page.tsx:11`
- `app/dashboard/page.tsx:48`
- `app/dashboard/page.tsx:58`
- `components/ChatAssistant.tsx:7`
- `components/ChatAssistant.tsx:9`
- `lib/ai-parse.ts:3`

</details>

**Why it matters:** Every `any` switches the type checker off for that value. A high density means TypeScript is mostly decorative and refactors break silently.

**How to fix:** Replace `any` with real types or `unknown` + narrowing; generate database types (`supabase gen types typescript`, Prisma client) instead of `any` rows.

### Low (9)

#### 29. ESLint is skipped during `next build`

**Severity:** Low · **Category:** Next.js · **Check:** `nextjs/build-checks-disabled`

**Location:** `next.config.js:11`

next.config.js sets eslint.ignoreDuringBuilds: true. Make sure lint runs in CI instead.

```js
ignoreDuringBuilds: true,
```

**Why it matters:** `ignoreBuildErrors` lets a build with type errors deploy, so bugs the compiler already found reach production. AI tools switch it on to get a red build to go green.

**How to fix:** Remove `typescript.ignoreBuildErrors` / `eslint.ignoreDuringBuilds` and fix the reported errors (run `npx tsc --noEmit`).

#### 30. next/image optimization is turned off

**Severity:** Low · **Category:** Next.js · **Check:** `nextjs/images-unoptimized`

**Location:** `next.config.js:4`

next.config.js sets images.unoptimized: true for a server-rendered app.

```js
unoptimized: true,
```

**Why it matters:** `images.unoptimized: true` serves original, full-size images to every device: slower Largest Contentful Paint, worse SEO, higher bandwidth bills. It is often copied from static-export examples.

**How to fix:** Remove `unoptimized: true` and configure `images.remotePatterns` for external hosts. Keep it only with `output: "export"`.

#### 31. App Router has no error.tsx

**Severity:** Low · **Category:** Next.js · **Check:** `nextjs/missing-error-boundary`

**Location:** `app`

No error.tsx or global-error.tsx under app/.

**Why it matters:** Without an error.tsx, an exception in any server or client component shows the bare Next.js crash screen (or a blank page) instead of a recoverable UI.

**How to fix:** Add app/error.tsx (a "use client" component with a reset button) and app/global-error.tsx for errors in the root layout.

#### 32. App Router has no not-found.tsx

**Severity:** Low · **Category:** Next.js · **Check:** `nextjs/missing-not-found`

**Location:** `app`

No app/not-found.tsx.

**Why it matters:** The default 404 page has no navigation back into your app and no branding; broken links become dead ends.

**How to fix:** Add app/not-found.tsx (App Router) or pages/404.tsx (Pages Router) with a link home.

#### 33. Root layout exports no metadata

**Severity:** Low · **Category:** Configuration · **Check:** `seo/missing-metadata`

**Location:** `app/layout.tsx`

app/layout.tsx exports neither `metadata` nor `generateMetadata`.

**Why it matters:** Search results and link previews (Slack, X, WhatsApp) use the title and description. Without them, your app shows up as "Create Next App" or a bare URL.

**How to fix:** Export `metadata` (title template, description, openGraph) from the root layout, or add `<title>` and `<meta name="description">` to index.html.

#### 34. No robots.txt

**Severity:** Low · **Category:** Configuration · **Check:** `seo/missing-robots`

Neither public/robots.txt nor an app/robots route exists.

**Why it matters:** Without robots.txt crawlers guess; you cannot keep /dashboard or /api out of search results or point crawlers to your sitemap.

**How to fix:** Add app/robots.ts (Next.js) or public/robots.txt that disallows private paths and links the sitemap.

#### 35. No sitemap

**Severity:** Low · **Category:** Configuration · **Check:** `seo/missing-sitemap`

No sitemap.xml or app/sitemap route was found.

**Why it matters:** A sitemap gets new pages indexed faster and is expected by Google Search Console.

**How to fix:** Add app/sitemap.ts (Next.js) or generate public/sitemap.xml at build time (e.g. vite-plugin-sitemap, next-sitemap).

#### 36. 3 console.log calls left in source

**Severity:** Low · **Category:** Code quality · **Check:** `code-quality/console-log`

**Location:** `app/dashboard/page.tsx:21` and 2 more

3 debug logs in 2 files (3 in browser code); most in app/dashboard/page.tsx (2), components/ChatAssistant.tsx (1).

```tsx
console.log('loaded data', todoData, noteData);
```

<details><summary>All locations (3)</summary>

- `app/dashboard/page.tsx:21`
- `app/dashboard/page.tsx:28`
- `components/ChatAssistant.tsx:20`

</details>

**Why it matters:** Debug logging in browser code leaks internal data (API responses, user objects, tokens) to anyone with DevTools open, and on the server it floods logs with unstructured noise that hides real errors.

**How to fix:** Remove debug logs, or use a logger with levels (pino, consola) and strip `console.log` in production builds (`compiler.removeConsole` in next.config).

#### 37. 2 TODO/FIXME markers, 2 security-related

**Severity:** Low · **Category:** Code quality · **Check:** `code-quality/todo-comments`

**Location:** `app/api/todos/[id]/route.ts:4` and 1 more

2 markers (0 FIXME/HACK/XXX). Security-related: app/api/todos/[id]/route.ts:4, app/dashboard/actions.ts:8.

```ts
// TODO: add auth check before launch
```

<details><summary>All locations (2)</summary>

- `app/api/todos/[id]/route.ts:4`
- `app/dashboard/actions.ts:8`
- `app/api/todos/[id]/route.ts:4`
- `app/dashboard/actions.ts:8`

</details>

**Why it matters:** AI-generated code often leaves "TODO: add auth" or "FIXME: validate input" where a real implementation is required. Each one is worth a look before launch.

**How to fix:** Review each marker; implement or track it in your issue tracker, then delete it.

## Scope and method

- **Automated static analysis** of 19 source and configuration files (dependencies, build output and gitignored files excluded), using 34 checks that apply to this stack.
- Checks marked **heuristic** infer intent from code patterns (for example "this handler has no auth check") and can produce false positives; confirm them before acting.
- Secrets are redacted in this report. Any key listed here should be treated as compromised and rotated.
- This is not a penetration test: business-logic flaws, infrastructure configuration and runtime behaviour are out of scope.
- Dependency vulnerability scanning (`npm audit`) was not run for this report.

<details><summary>Appendix: checks performed</summary>

| Check | Category | Result |
|---|---|---|
| `secrets/hardcoded-key` Hard-coded secret | Secrets & credentials | 1 finding |
| `secrets/env-file-committed` .env file committed or not gitignored | Secrets & credentials | 1 finding |
| `secrets/public-env-secret` Secret exposed through a public env prefix | Secrets & credentials | 2 findings |
| `secrets/server-env-in-client` Server-only env var read in browser code | Secrets & credentials | 1 finding |
| `supabase/rls-disabled` Table without Row Level Security | Supabase | 1 finding |
| `supabase/permissive-policy` RLS policy that allows everything | Supabase | 1 finding |
| `supabase/service-role-in-client` Supabase service_role key used in browser code | Supabase | 1 finding |
| `nextjs/build-checks-disabled` Type checking or linting disabled during build | Next.js | 2 findings |
| `nextjs/images-unoptimized` Image optimization disabled | Next.js | 1 finding |
| `nextjs/missing-error-boundary` No error boundary | Next.js | 1 finding |
| `nextjs/missing-not-found` No custom 404 page | Next.js | 1 finding |
| `security/server-module-in-client` Server-only module imported into browser code | Application security | 2 findings |
| `security/dangerously-set-inner-html` dangerouslySetInnerHTML with dynamic content | Application security | 1 finding |
| `security/unauthenticated-route` API endpoint with no visible auth check | Application security | 3 findings |
| `security/unverified-webhook` Webhook endpoint without signature verification | Application security | 1 finding |
| `security/missing-security-headers` Security headers not configured | Application security | 1 finding |
| `security/missing-csp` No Content-Security-Policy | Application security | 1 finding |
| `seo/missing-robots` No robots.txt | Configuration | 1 finding |
| `seo/missing-sitemap` No sitemap | Configuration | 1 finding |
| `seo/missing-metadata` No page title / description metadata | Configuration | 1 finding |
| `config/typescript-strict` TypeScript strict mode is off | Configuration | 1 finding |
| `code-quality/any-density` High density of `any` | Code quality | 1 finding |
| `code-quality/console-log` Leftover console.log calls | Code quality | 1 finding |
| `code-quality/debugger` debugger statement | Code quality | Pass |
| `code-quality/todo-comments` TODO / FIXME comments | Code quality | 1 finding |
| `security/eval` Dynamic code execution (eval / new Function) | Application security | 1 finding |
| `security/cors-wildcard-credentials` CORS allows any origin with credentials | Application security | 1 finding |
| `security/sql-injection` SQL built from interpolated strings | Application security | Pass |
| `config/env-example` Env vars used in code but not documented | Configuration | 1 finding |
| `dependencies/missing-lockfile` No lockfile committed | Dependencies | 1 finding |
| `dependencies/unpinned-version` Dependency on "latest" or an open-ended range | Dependencies | 1 finding |
| `dependencies/react-version-mismatch` Mismatched or duplicate React versions | Dependencies | 1 finding |
| `dependencies/outdated-framework` Framework major version is out of support | Dependencies | 1 finding |
| `dependencies/next-middleware-bypass` Next.js version vulnerable to middleware bypass (CVE-2025-29927) | Dependencies | 1 finding |

</details>

---

_Generated by [launch-check](https://www.npmjs.com/package/launch-check) v0.0.0-test on 2026-01-15._
