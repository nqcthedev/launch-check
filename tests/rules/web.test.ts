import { describe, expect, it } from 'vitest';
import { findings, nextPkg } from '../helpers.js';

const base = { 'package.json': nextPkg(), 'app/layout.tsx': 'export default function L({ children }) { return children }', 'app/page.tsx': 'x' };

const fullHeaders = `module.exports = { async headers() { return [{ source: '/:path*', headers: [
  { key: 'Content-Security-Policy', value: "default-src 'self'" },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=()' },
] }] } }`;

describe('security/missing-security-headers and security/missing-csp', () => {
  it('flags a Next.js app with no headers configured', async () => {
    const files = { ...base, 'next.config.js': 'module.exports = {}' };
    const headers = await findings(files, 'security/missing-security-headers');
    expect(headers).toHaveLength(1);
    expect(headers[0]!.title).toBe('5 of 5 recommended security headers missing');
    expect(await findings(files, 'security/missing-csp')).toHaveLength(1);
  });

  it('passes when next.config sets them', async () => {
    const files = { ...base, 'next.config.js': fullHeaders };
    expect(await findings(files, 'security/missing-security-headers')).toEqual([]);
    expect(await findings(files, 'security/missing-csp')).toEqual([]);
  });

  it('reads headers from vercel.json and netlify _headers too', async () => {
    const files = {
      'package.json': { dependencies: { react: '19.0.0', 'react-dom': '19.0.0', vite: '6.0.0' } },
      'index.html': '<title>x</title>',
      'public/_headers': '/*\n  Content-Security-Policy: default-src self\n  Strict-Transport-Security: max-age=1\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n',
    };
    const headers = await findings(files, 'security/missing-security-headers');
    expect(headers.map((f) => f.severity)).toEqual(['low']);
    expect(await findings(files, 'security/missing-csp')).toEqual([]);
  });

  it('accepts helmet() in an Express server', async () => {
    const files = {
      'package.json': { dependencies: { express: '5.0.0', helmet: '8.0.0' } },
      'src/server.ts': "import helmet from 'helmet';\napp.use(helmet());",
    };
    expect(await findings(files, 'security/missing-security-headers')).toEqual([]);
    expect(await findings(files, 'security/missing-csp')).toEqual([]);
  });
});

describe('seo rules', () => {
  it('flags missing robots, sitemap and metadata', async () => {
    expect(await findings(base, 'seo/missing-robots')).toHaveLength(1);
    expect(await findings(base, 'seo/missing-sitemap')).toHaveLength(1);
    expect(await findings(base, 'seo/missing-metadata')).toHaveLength(1);
  });

  it('flags the create-next-app placeholder title', async () => {
    const out = await findings(
      { ...base, 'app/layout.tsx': `export const metadata = { title: 'Create Next App' };\nexport default function L() {}` },
      'seo/missing-metadata',
    );
    expect(out[0]!.title).toBe('Default "Create Next App" title');
  });

  it('passes with app/robots.ts, app/sitemap.ts and exported metadata', async () => {
    const files = {
      ...base,
      'app/layout.tsx': `export const metadata = { title: 'Acme', description: 'x' };\nexport default function L() {}`,
      'app/robots.ts': 'export default function robots() {}',
      'app/sitemap.ts': 'export default function sitemap() {}',
    };
    expect(await findings(files, 'seo/missing-robots')).toEqual([]);
    expect(await findings(files, 'seo/missing-sitemap')).toEqual([]);
    expect(await findings(files, 'seo/missing-metadata')).toEqual([]);
  });

  it('checks index.html for Vite apps', async () => {
    const vite = { 'package.json': { dependencies: { react: '19.0.0', vite: '6.0.0' } } };
    const bad = await findings({ ...vite, 'index.html': '<title>Vite + React</title>' }, 'seo/missing-metadata');
    expect(bad[0]!.message).toContain('placeholder title "Vite + React"');
    const good = await findings(
      { ...vite, 'index.html': '<title>Acme</title><meta name="description" content="x">', 'public/robots.txt': 'User-agent: *' },
      'seo/missing-metadata',
    );
    expect(good).toEqual([]);
  });
});
