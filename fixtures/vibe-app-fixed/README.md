# TaskPilot (fixed)

AI-powered todo list built with Next.js, Supabase, OpenAI and Stripe.

> **launch-check fixture.** This is `vibe-app-broken` after a production-readiness pass:
> every finding from the launch-check report has been fixed. See the case study in the
> launch-check README for the before/after reports and the key diffs.

## Getting started

```bash
cp .env.example .env.local   # fill in real values
npm ci
npm run dev
```

Apply the database migrations with `supabase db push`.
