import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit } from '../src/audit.js';
import { renderMarkdown } from '../src/reporters/markdown.js';
import { renderTerminal } from '../src/reporters/terminal.js';
import type { AuditResult } from '../src/types.js';

const fixture = (name: string) => join(import.meta.dirname, '..', 'fixtures', name);
const NOW = new Date('2026-01-15T09:00:00.000Z');

/** Strip machine-specific values so snapshots are stable everywhere. */
function normalize(result: AuditResult): AuditResult {
  return { ...result, project: { ...result.project, root: '<root>' }, durationMs: 0, tool: { ...result.tool, version: '0.0.0-test' } };
}

async function report(name: string): Promise<AuditResult> {
  return normalize(await audit(fixture(name), { git: false, audit: false, now: NOW }));
}

describe('fixtures/vibe-app-broken', () => {
  it('finds every planted issue', async () => {
    const result = await report('vibe-app-broken');
    const ids = new Set(result.findings.map((f) => f.ruleId));
    for (const id of [
      'secrets/env-file-committed',
      'secrets/hardcoded-key',
      'secrets/public-env-secret',
      'secrets/server-env-in-client',
      'supabase/rls-disabled',
      'supabase/permissive-policy',
      'supabase/service-role-in-client',
      'security/unauthenticated-route',
      'security/unverified-webhook',
      'security/cors-wildcard-credentials',
      'security/dangerously-set-inner-html',
      'security/eval',
      'security/server-module-in-client',
      'security/missing-security-headers',
      'security/missing-csp',
      'nextjs/build-checks-disabled',
      'nextjs/images-unoptimized',
      'nextjs/missing-error-boundary',
      'nextjs/missing-not-found',
      'dependencies/next-middleware-bypass',
      'dependencies/react-version-mismatch',
      'dependencies/missing-lockfile',
      'dependencies/unpinned-version',
      'dependencies/outdated-framework',
      'config/typescript-strict',
      'config/env-example',
      'seo/missing-metadata',
      'seo/missing-robots',
      'seo/missing-sitemap',
      'code-quality/any-density',
      'code-quality/console-log',
      'code-quality/todo-comments',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(result.grade).toBe('F');
    expect(result.counts.critical).toBeGreaterThanOrEqual(8);
  });

  it('matches the JSON snapshot', async () => {
    const result = await report('vibe-app-broken');
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/vibe-app-broken.json');
  });

  it('matches the terminal snapshot', async () => {
    const result = await report('vibe-app-broken');
    await expect(renderTerminal(result, { color: false, width: 100 })).toMatchFileSnapshot('./__snapshots__/vibe-app-broken.terminal.txt');
  });

  it('matches the Markdown report snapshot', async () => {
    const result = await report('vibe-app-broken');
    await expect(renderMarkdown(result)).toMatchFileSnapshot('./__snapshots__/vibe-app-broken.report.md');
  });
});

describe('fixtures/vibe-app-fixed', () => {
  it('has no findings', async () => {
    const result = await report('vibe-app-fixed');
    expect(result.findings).toEqual([]);
    expect(result.score).toBe(100);
    expect(result.errors).toEqual([]);
  });

  it('matches the terminal and Markdown snapshots', async () => {
    const result = await report('vibe-app-fixed');
    await expect(renderTerminal(result, { color: false, width: 100 })).toMatchFileSnapshot('./__snapshots__/vibe-app-fixed.terminal.txt');
    await expect(renderMarkdown(result)).toMatchFileSnapshot('./__snapshots__/vibe-app-fixed.report.md');
  });
});
