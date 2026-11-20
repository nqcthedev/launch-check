| | Before (`fixtures/vibe-app-broken`) | After (`fixtures/vibe-app-fixed`) |
|---|---|---|
| Score | **13/100 (F)** | **100/100 (A)** |
| Critical | 8 | 0 |
| High | 12 | 0 |
| Medium | 8 | 0 |
| Low | 9 | 0 |
| Info | 0 | 0 |
| `--fail-on high` exit code | 1 (CI fails) | 0 (CI passes) |
| Checks run | 34 | 35 |

<details><summary><b>Every finding in the "before" report</b> (all resolved in the fixed app)</summary>

| Severity | Check | Finding | Location |
|---|---|---|---|
| Critical | `secrets/env-file-committed` | .env with live secrets is committed | `.env:4` |
| Critical | `secrets/hardcoded-key` | Stripe live secret key hard-coded in source | `lib/stripe.ts:3` |
| Critical | `secrets/public-env-secret` | NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is shipped to the browser | `.env:4` |
| Critical | `secrets/public-env-secret` | NEXT_PUBLIC_OPENAI_API_KEY is shipped to the browser | `.env:5` |
| Critical | `supabase/rls-disabled` | Table "todos" has Row Level Security disabled | `supabase/migrations/20240115120000_init.sql:17` |
| Critical | `supabase/service-role-in-client` | Supabase service_role key used in browser code | `lib/supabase.ts:5` |
| Critical | `security/unverified-webhook` | Webhook trusts unsigned requests _(heuristic)_ | `app/api/webhooks/stripe/route.ts:4` |
| Critical | `dependencies/next-middleware-bypass` | next 14.1.0 allows bypassing middleware.ts | `package.json:13` |
| High | `secrets/server-env-in-client` | STRIPE_SECRET_KEY read in client code | `lib/stripe.ts:3` |
| High | `supabase/permissive-policy` | Policy "Enable all access for all users" lets anyone with your public anon key write "notes" | `supabase/migrations/20240115120000_init.sql:35` |
| High | `security/cors-wildcard-credentials` | CORS allows any origin together with credentials | `app/api/chat/route.ts:5` |
| High | `security/dangerously-set-inner-html` | Unsanitized HTML passed to dangerouslySetInnerHTML | `app/dashboard/page.tsx:59` |
| High | `security/eval` | eval() executes a string as code | `lib/ai-parse.ts:6` |
| High | `security/server-module-in-client` | Client bundle imports "openai" | `lib/openai.ts:1` |
| High | `security/server-module-in-client` | Client bundle imports "stripe" | `lib/stripe.ts:1` |
| High | `security/unauthenticated-route` | Route handler POST /api/chat has no auth check _(heuristic)_ | `app/api/chat/route.ts:14` |
| High | `security/unauthenticated-route` | Route handler DELETE /api/todos/[id] has no auth check _(heuristic)_ | `app/api/todos/[id]/route.ts:5` |
| High | `security/unauthenticated-route` | Server action updateProfile() has no auth check _(heuristic)_ | `app/dashboard/actions.ts:5` |
| High | `nextjs/build-checks-disabled` | TypeScript errors are ignored during `next build` | `next.config.js:8` |
| High | `dependencies/react-version-mismatch` | react "^18.2.0" and react-dom "latest" do not match | `package.json:16` |
| Medium | `security/missing-csp` | No Content-Security-Policy header | `next.config.js` |
| Medium | `security/missing-security-headers` | 5 of 5 recommended security headers missing | `next.config.js` |
| Medium | `dependencies/missing-lockfile` | No lockfile | `package.json` |
| Medium | `dependencies/outdated-framework` | next 14.1.0 is 2 major versions behind | `package.json:13` |
| Medium | `dependencies/unpinned-version` | 1 dependency not pinned | `package.json:16` |
| Medium | `config/env-example` | No .env.example | `lib/openai.ts:4` |
| Medium | `config/typescript-strict` | tsconfig.json: "strict" is set to false | `tsconfig.json:7` |
| Medium | `code-quality/any-density` | 8 explicit `any`s (30.4 per 1,000 lines) | `app/dashboard/actions.ts:7` |
| Low | `nextjs/build-checks-disabled` | ESLint is skipped during `next build` | `next.config.js:11` |
| Low | `nextjs/images-unoptimized` | next/image optimization is turned off | `next.config.js:4` |
| Low | `nextjs/missing-error-boundary` | App Router has no error.tsx | `app` |
| Low | `nextjs/missing-not-found` | App Router has no not-found.tsx | `app` |
| Low | `seo/missing-metadata` | Root layout exports no metadata | `app/layout.tsx` |
| Low | `seo/missing-robots` | No robots.txt |  |
| Low | `seo/missing-sitemap` | No sitemap |  |
| Low | `code-quality/console-log` | 3 console.log calls left in source | `app/dashboard/page.tsx:21` |
| Low | `code-quality/todo-comments` | 2 TODO/FIXME markers, 2 security-related | `app/api/todos/[id]/route.ts:4` |

</details>
