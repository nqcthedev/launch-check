# Method: static audit of 300 public AI-built apps

Data collected and scanned on 20 November 2026. Everything below can be repeated with the `gh` CLI, `git` and [launch-check](https://github.com/nqcthedev/launch-check).

## What was measured

Source code only. Each repository was shallow-cloned and scanned with launch-check, a static analysis CLI. No dependency was installed, no project code or script was run, no deployed app, database or API was contacted, and no credential was tested. The published files contain no repository name, owner or URL.

## Tool version

- launch-check 0.1.0, branch `research/precision-fixes`, commit **`a48a72a`** (three commits on top of `bbe6332`: `9b35bac`, `3b4ee71`, `a48a72a`).
- Command per repository: `launch-check <dir> --json --no-audit --fail-on none`. `--no-audit` skips `npm audit`, so known-vulnerable dependencies are **not** part of these numbers (the only dependency check included is the built-in Next.js CVE-2025-29927 version check). `--build` was never used.
- 177 tests pass on that commit (149 before; 28 new regression tests in `tests/rules/field-regressions.test.ts`).

## Sample selection

### Fingerprints

A repository entered the candidate list through one objective marker, found with the GitHub code search REST API (`GET /search/code`):

| Group | Marker | Query | What the marker proves |
|---|---|---|---|
| Lovable | `lovable-tagger` in the root `package.json` | `lovable-tagger filename:package.json` | The project was scaffolded by Lovable |
| Bolt | a root `.bolt/` directory | `path:.bolt filename:config.json`, `path:.bolt filename:prompt` | The project was scaffolded by Bolt |
| v0 | `"name": "my-v0-project"` in the root `package.json` | `"my-v0-project" filename:package.json` | The project was exported from v0 |
| Cursor | a root `.cursorrules` file | `filename:.cursorrules <kw>` | A Cursor instructions file is committed |
| Claude Code | a root `CLAUDE.md` file | `filename:CLAUDE.md <kw>` | A Claude Code instructions file is committed |

`<kw>` is one of `supabase`, `firebase`, `prisma`, `stripe`, `clerk`, `drizzle` (six queries per group, taken round-robin). The plain `filename:.cursorrules` / `filename:CLAUDE.md` queries return established libraries first, which are not apps, so the keyword narrows the search to projects whose instructions file mentions a backend.

The first three markers are strong: the builder created the project. The last two are weaker: they show AI-assisted development, not that the app was generated end to end. To keep out older projects that merely added an instructions file later, Cursor and Claude Code repositories also had to be **created on or after 1 January 2025**.

60 of the 300 repositories carry a second marker as well (most often a Lovable, Bolt or v0 project that also has a `CLAUDE.md` or Cursor file). Each repository is counted once, under the query that found it.

### Order and filters

Results were taken **in the order the API returned them** (best-match order; up to 1,000 results per query) and walked top to bottom until 60 repositories per group passed every filter. Nothing was picked or dropped by hand, and no scan result was looked at before a repository was accepted. The filters were fixed before any scan:

1. The marker sits at the repository root (not a backup file or a subfolder).
2. Not a fork, not flagged as a template, not disabled; at most 300 MB.
3. Name, description and topics do not contain: template, starter, boilerplate, tutorial, example(s), sample, demo, course, workshop, bootcamp, lesson, playground, scaffold, skeleton, homework, assignment, practice, learning, clone, kit.
4. Root `package.json` depends on `react` and one of `next`, `vite`, `react-scripts`. Monorepos without a root app and non-React stacks are out.
5. "Real app": the dependencies include at least one auth, database or payments library (Supabase, Firebase, Clerk, Auth.js, better-auth, Prisma, Drizzle, pg, mongoose, Stripe and similar), **and** at least one source file imports it.
6. Not a toy: at least 2,000 non-blank lines of own JS/TS, not counting `components/ui/` (generated shadcn/ui code).
7. One repository per owner; identical file trees are counted once.

Repository metadata (fork, template flag, size, dates, description, topics) came from `GET /search/repositories` with `repo:` qualifiers. `package.json` was read from the clone.

### Funnel

| Group | Search results at root | Examined in order | Accepted | Main reasons for rejection |
|---|---|---|---|---|
| Lovable | 745 | 146 | 60 | no auth/DB/payments dependency (73) |
| Bolt | 1,019 | 250 | 60 | not a Next/Vite/CRA React app (64), no backend dependency (53), name/description filter (28) |
| v0 | 762 | 276 | 60 | no auth/DB/payments dependency (185) |
| Cursor | 3,211 | 310 | 60 | created before 2025 (70), not a React web app (63), name/description filter (46) |
| Claude Code | 4,673 | 358 | 60 | created before 2025 (93), not a React web app (79), no root package.json (63) |

Resulting sample: 300 repositories. 168 Next.js, 131 Vite + React, 1 Create React App. 182 use Supabase, 36 Firebase, 43 Stripe. Own-code size: 79 under 5k lines, 112 between 5k and 15k, 64 between 15k and 50k, 45 above 50k.

### Handling of untrusted code

Shallow clone (`--depth 1`) with symlinks and hooks disabled and LFS skipped, into a scratch directory outside any project. No `npm install`, no build, no script execution. The per-repository data (names, clone paths, raw findings) stays in that private scratch directory. Opaque ids `R001`–`R300` in the published files were assigned in random order; the mapping is not published.

## Validation

launch-check is static and several of its rules are heuristics, so the raw output could not be published as it was.

**Procedure.** For the rules that matter most, a seeded random sample of findings was drawn (at most one finding per repository per rule) and each one was read at the flagged file and line. Wrong or noisy patterns were fixed in launch-check with a regression test, the whole sample of 300 was scanned again, and a fresh random sample was drawn. This was done four times. **205 findings were read by hand in total** (84 on the original version, then 71, 40 and 10).

**What the first pass looked like** (original version `bbe6332`, 6 findings per rule):

| Rule | Correct in the first sample | What was wrong |
|---|---|---|
| `security/unverified-webhook` | 0 of 6 | React `hooks/` folders matched as webhook paths; secret-header and helper-based verification not recognised |
| `security/dangerously-set-inner-html` | 0 of 6 | 5 of 6 were the stock shadcn/ui `chart.tsx` (a `<style>` block), 1 was JSON-LD |
| `secrets/hardcoded-key` | 1 of 6 | test fakes, PEM header strings in code, placeholder and template-literal database URLs, Firebase web config keys |
| `security/sql-injection` | 0 of 6 exploitable | interpolated constants, `Number(...)`, internal table names |
| `supabase/rls-disabled` | 4 of 6 | temporary tables; Prisma migrations in projects with no Supabase |
| `secrets/public-env-secret` | 4 of 6 | Mapbox public tokens, Firebase database URL |
| `security/unauthenticated-route` | 3 of 6 | return types with object literals broke body detection; project-specific auth helpers; sign-up endpoints |

The same 300 repositories scored worse on the original version: 132 (44%) had a critical finding and the median score was 48. After the fixes it is 84 (28%) and 57.5. The published numbers are the lower ones.

**Final precision.** Verdicts were recorded for the last three rounds. Of those sampled findings, 89 are still reported by the final version `a48a72a`. Each got one of three verdicts: *actionable* (the flagged condition is true and I would tell the owner to fix it), *context-dependent* (the condition is true as written, but whether it matters depends on facts that are not in the repository, for example whether an endpoint is public on purpose) and *wrong*.

| Rule (severity counted in the article) | Reviewed | Actionable | Context-dependent | Wrong |
|---|---|---|---|---|
| `supabase/rls-disabled` | 11 | 7 | 4 | 0 |
| `supabase/permissive-policy` (high: update/delete/all with `using (true)`) | 6 | 6 | 0 | 0 |
| `security/unauthenticated-route` (high) | 13 | 8 | 4 | 1 |
| `security/unauthenticated-route` (medium) | 12 | 7 | 4 | 1 |
| `secrets/hardcoded-key` (critical/high) | 8 | 7 | 1 | 0 |
| `secrets/public-env-secret` | 6 | 4 | 2 | 0 |
| `secrets/env-file-committed` (critical) | 4 (all) | 3 | 1 | 0 |
| `security/unverified-webhook` | 7 | 7 | 0 | 0 |
| `supabase/service-role-in-client` | 4 | 4 | 0 | 0 |
| `secrets/server-env-in-client` | 4 | 3 | 1 | 0 |
| `security/server-module-in-client` (high) | 6 | 2 | 4 | 0 |
| `security/dangerously-set-inner-html` | 6 | 1 | 5 | 0 |
| `firebase/open-security-rules` (critical) | 2 (all) | 2 | 0 | 0 |
| **Total** | **89** | **61 (69%)** | **26 (29%)** | **2 (2%)** |

Samples of 4 to 13 per rule are small. Treat the per-rule figures as a rough guide, not as measured error rates.

Two rules were also checked completely rather than sampled:

- **Hard-coded credentials (critical/high):** all 24 findings in 14 repositories were looked at (redacted). 12 repositories hold what looks like a real credential (database URLs with passwords, service-account private keys, Supabase `service_role` keys, Gemini and other API keys). One is a private key inside a test file and one is a default value in a settings dialog; both are counted in the 14 and may be harmless. Whether any key is still valid is unknown and was not tested.
- **Unverified webhooks:** all 9 handlers in 8 repositories were read; none checks a signature or shared secret.

**Security headers cross-check.** The header rules look at framework, middleware and hosting config files. A separate text search over every source and config file in each flagged repository found some mention of a header name in 24 of the 269 repositories flagged for missing headers, and of `Content-Security-Policy` in 10 of the 273 flagged for missing CSP (nginx files, nested middleware, or one or two headers only). The conservative figures are therefore 245 of 300 (82%) with no baseline header configured anywhere in the repo and 263 of 300 (88%) with no CSP anywhere.

**Not validated by hand:** `nextjs/build-checks-disabled`, `config/typescript-strict`, `dependencies/*` (exact string or version matches), and the low-severity SEO and code-quality rules.

**Left out of the article on purpose:** `security/sql-injection` (12 repositories flagged, 0 of 6 reviewed findings were exploitable) and the medium tier of `security/unauthenticated-route` as a headline.

## Changes made to launch-check

All on branch `research/precision-fixes`, local only.

- `9b35bac` RLS: skip temporary tables, only run for Supabase projects. Policies: insert-only open policies are medium; do not claim "any row" when `USING` is scoped. Firebase: public read is medium. Secrets: PEM needs key material, ignore placeholder and interpolated database URLs, the local `supabase-demo` key and fakes in tests; Firebase web config key is info, Gemini key is high. Public-by-design names (Mapbox, Firebase database URL, browser keys). Routes: correct body detection behind object return types and wrapper calls, recognise project-specific guards, skip sign-in/sign-up endpoints. Webhooks: React hooks are not webhooks, recognise shared-secret verification. `dangerouslySetInnerHTML`: ignore `<style>` and JSON-LD. Import graph: type-only imports do not bundle server code.
- `3b4ee71` Routes: high severity needs a database write or a privileged/paid client; a bare unauthenticated POST is medium. More skips for stubs, ingest endpoints, bcrypt hashes, SQL test fixtures and string literals.
- `a48a72a` Cookie, URL-parameter and Map deletes are not database writes.

## Limits

1. **Static analysis.** The tool reads files. It cannot see Row Level Security or policies set in the Supabase dashboard, headers added by a host or CDN, environment variables set in Vercel, or auth done in a helper it does not recognise. A finding is a reason to look, not proof of a breach.
2. **Public repositories only.** People who publish their code are not the same population as people running private production apps. Many of these repos are side projects, prototypes or abandoned. Nothing here supports a claim about "X% of all AI-built apps".
3. **Selection.** GitHub's best-match order is not a random sample and is not fully stable between runs. The "real app" filter requires a backend library, which raises the share of apps where auth and database mistakes are possible at all. The Cursor and Claude Code groups were found through keyword queries.
4. **Groups are not comparable like for like.** All Lovable repos are Vite, all v0 repos are Next.js. The route, server-action, build-flag and middleware checks only apply to Next.js. launch-check does not inspect Supabase Edge Functions, which is where Lovable and Bolt apps put server logic. So a Lovable repo has fewer checks that can fail. With 60 repos per group, a percentage carries a 95% margin of roughly ±12 points.
5. **Attribution.** A marker shows which tool touched the repository, not who wrote the flagged line. Human edits and several tools are mixed in.
6. **Git history is not scanned.** Secrets deleted from the current tree are not counted, so secret numbers are a lower bound.
7. **The score** is launch-check's own weighted formula. It is useful for ranking a to-do list, not a calibrated risk measure.

## Files

- `results.json`: `summary` (sample, funnel, score distribution, every metric with counts, percentages and 95% Wilson intervals, per-rule totals, validation table) and `repos` (300 anonymised rows).
- `results.csv`: the same rows, one per repository: id, group, other markers, framework, integrations, size bucket, score, grade, counts by severity, one 0/1 column per headline metric (blank where the check does not apply) and one count column per rule.
- `charts/`: three PNGs at 2x and `make-charts.mjs`, which draws them from `results.json`.
