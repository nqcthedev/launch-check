import { describe, expect, it } from 'vitest';
import { parseAuditJson } from '../../src/rules/deps.js';
import { findings, nextPkg } from '../helpers.js';

const npmLock = (pkgs: Record<string, string>) => ({
  name: 'app',
  lockfileVersion: 3,
  packages: Object.fromEntries([['', { name: 'app' }], ...Object.entries(pkgs).map(([k, v]) => [k, { version: v }])]),
});

describe('dependencies/missing-lockfile', () => {
  it('flags a project without a lockfile', async () => {
    expect(await findings({ 'package.json': nextPkg() }, 'dependencies/missing-lockfile')).toHaveLength(1);
  });
  it('accepts any supported lockfile', async () => {
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
      expect(await findings({ 'package.json': nextPkg(), [lock]: '{}' }, 'dependencies/missing-lockfile')).toEqual([]);
    }
  });
});

describe('dependencies/unpinned-version', () => {
  it('flags latest, * and open >= ranges', async () => {
    const out = await findings(
      { 'package.json': { dependencies: { a: 'latest', b: '*', c: '>=1.0.0', d: '^1.2.3', e: 'workspace:*', f: '>=1 <2' } } },
      'dependencies/unpinned-version',
    );
    expect(out[0]!.message).toBe('a@"latest", b@"*", c@">=1.0.0".');
  });
  it('passes caret and exact versions', async () => {
    expect(await findings({ 'package.json': nextPkg() }, 'dependencies/unpinned-version')).toEqual([]);
  });
});

describe('dependencies/react-version-mismatch', () => {
  it('flags react / react-dom range mismatches', async () => {
    const out = await findings({ 'package.json': { dependencies: { react: '^18.2.0', 'react-dom': '^19.0.0' } } }, 'dependencies/react-version-mismatch');
    expect(out).toHaveLength(1);
  });
  it('flags duplicate React majors in the lockfile', async () => {
    const out = await findings(
      {
        'package.json': { dependencies: { react: '19.1.0', 'react-dom': '19.1.0' } },
        'package-lock.json': npmLock({ 'node_modules/react': '19.1.0', 'node_modules/old-lib/node_modules/react': '17.0.2', 'node_modules/react-dom': '19.1.0' }),
      },
      'dependencies/react-version-mismatch',
    );
    expect(out.map((f) => f.title)).toEqual(['react installed in 2 versions']);
  });
  it('passes matching versions', async () => {
    expect(await findings({ 'package.json': nextPkg() }, 'dependencies/react-version-mismatch')).toEqual([]);
  });
});

describe('dependencies/outdated-framework', () => {
  it('flags majors two or more behind, with Next <= 13 as high', async () => {
    const out = await findings({ 'package.json': { dependencies: { next: '^13.4.0', react: '^17.0.2', 'react-dom': '^17.0.2' } } }, 'dependencies/outdated-framework');
    expect(out.map((f) => [f.severity, f.title])).toEqual([
      ['high', 'next 13.4.0 is 3 major versions behind'],
      ['medium', 'react 17.0.2 is 2 major versions behind'],
    ]);
  });
  it('prefers the version resolved in the lockfile', async () => {
    const out = await findings(
      { 'package.json': { dependencies: { next: '>=13' } }, 'package-lock.json': npmLock({ 'node_modules/next': '16.1.0' }) },
      'dependencies/outdated-framework',
    );
    expect(out).toEqual([]);
  });
});

describe('dependencies/next-middleware-bypass', () => {
  const mw = { 'middleware.ts': 'export function middleware(req) { if (!req.cookies.get("session")) return NextResponse.redirect("/login") }', 'app/page.tsx': 'x' };

  it('flags vulnerable exact versions when middleware does auth', async () => {
    const out = await findings({ 'package.json': { dependencies: { next: '14.1.0' } }, ...mw }, 'dependencies/next-middleware-bypass');
    expect(out.map((f) => f.severity)).toEqual(['critical']);
    expect(out[0]!.message).toContain('fixed in 14.2.25');
  });
  it('uses the lockfile version over the declared range', async () => {
    const vulnerable = await findings(
      { 'package.json': { dependencies: { next: '^15.0.0' } }, 'package-lock.json': npmLock({ 'node_modules/next': '15.1.0' }), ...mw },
      'dependencies/next-middleware-bypass',
    );
    expect(vulnerable).toHaveLength(1);
  });
  it('does not guess for caret ranges without a lockfile, and passes patched versions', async () => {
    expect(await findings({ 'package.json': { dependencies: { next: '^14.1.0' } }, ...mw }, 'dependencies/next-middleware-bypass')).toEqual([]);
    expect(await findings({ 'package.json': { dependencies: { next: '14.2.25' } }, ...mw }, 'dependencies/next-middleware-bypass')).toEqual([]);
    expect(await findings({ 'package.json': { dependencies: { next: '14.1.0' } }, 'app/page.tsx': 'x' }, 'dependencies/next-middleware-bypass')).toEqual([]);
  });
});

describe('parseAuditJson', () => {
  it('parses npm v7+ output, keeping only packages with their own advisories', () => {
    const raw = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        next: {
          name: 'next',
          severity: 'critical',
          isDirect: true,
          via: [{ title: 'Authorization Bypass in Next.js Middleware', url: 'https://github.com/advisories/GHSA-f82v-jwr5-mffw' }],
          range: '>=14.0.0 <14.2.25',
          fixAvailable: { name: 'next', version: '14.2.35' },
        },
        'some-wrapper': { name: 'some-wrapper', severity: 'high', isDirect: true, via: ['next'], fixAvailable: true },
        cookie: { name: 'cookie', severity: 'low', isDirect: false, via: [{ title: 'cookie accepts out of bounds characters' }], fixAvailable: true },
      },
    });
    expect(parseAuditJson(raw)).toEqual([
      {
        name: 'next',
        severity: 'critical',
        title: 'Authorization Bypass in Next.js Middleware',
        url: 'https://github.com/advisories/GHSA-f82v-jwr5-mffw',
        range: '>=14.0.0 <14.2.25',
        fixAvailable: 'next@14.2.35',
        direct: true,
      },
      { name: 'cookie', severity: 'low', title: 'cookie accepts out of bounds characters', fixAvailable: true, direct: false },
    ]);
  });

  it('parses pnpm output', () => {
    const raw = JSON.stringify({
      advisories: { '1': { module_name: 'axios', severity: 'moderate', title: 'SSRF', url: 'https://x', vulnerable_versions: '<1.7.4', patched_versions: '>=1.7.4' } },
    });
    expect(parseAuditJson(raw)).toEqual([
      { name: 'axios', severity: 'medium', title: 'SSRF', url: 'https://x', range: '<1.7.4', fixAvailable: 'patched in >=1.7.4' },
    ]);
  });

  it('returns null for errors and garbage (offline, registry down)', () => {
    expect(parseAuditJson('npm ERR! network')).toBeNull();
    expect(parseAuditJson(JSON.stringify({ error: { code: 'ENOAUDIT' } }))).toBeNull();
  });
});

describe('dependencies/vulnerable-packages', () => {
  it('degrades to an info finding when audit cannot produce a report', async () => {
    const out = await findings(
      { 'package.json': { name: 'x', dependencies: { 'left-pad': '1.3.0' } }, 'package-lock.json': '{ not json' },
      'dependencies/vulnerable-packages',
      { audit: true, auditTimeoutMs: 20_000 },
    );
    expect(out.map((f) => f.severity)).toEqual(['info']);
    expect(out[0]!.title).toBe('npm audit could not run');
  });

  it('is skipped entirely with audit: false', async () => {
    const out = await findings({ 'package.json': nextPkg(), 'package-lock.json': '{}' }, 'dependencies/vulnerable-packages', { audit: false });
    expect(out).toEqual([]);
  });
});
