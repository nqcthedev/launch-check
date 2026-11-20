import type { FindingInput, ProjectContext } from '../types.js';
import { defineRule, isFrontend, isNext, isWebApp, middlewareFiles, nextConfigFiles } from './helpers.js';

/** Files where response headers are commonly configured. */
function headerSources(ctx: ProjectContext): string[] {
  const candidates = [
    ...nextConfigFiles(ctx),
    ...middlewareFiles(ctx),
    'vercel.json',
    'netlify.toml',
    'public/_headers',
    '_headers',
    'index.html',
    'firebase.json',
    'staticwebapp.config.json',
  ];
  const fromServer = ctx
    .sourceFiles()
    .map((f) => f.path)
    .filter((p) => /(^|\/)(server|app|index|main)\.[cm]?[jt]s$/.test(p) && !p.startsWith('src/components'));
  return [...new Set([...candidates, ...fromServer])].filter((p) => ctx.exists(p));
}

const HEADERS: Array<{ name: string; re: RegExp; purpose: string }> = [
  { name: 'Strict-Transport-Security', re: /strict-transport-security/i, purpose: 'forces HTTPS' },
  { name: 'X-Frame-Options / frame-ancestors', re: /x-frame-options|frame-ancestors/i, purpose: 'prevents clickjacking' },
  { name: 'X-Content-Type-Options', re: /x-content-type-options/i, purpose: 'stops MIME sniffing' },
  { name: 'Referrer-Policy', re: /referrer-policy/i, purpose: 'limits URL leakage to third parties' },
  { name: 'Permissions-Policy', re: /permissions-policy/i, purpose: 'disables unused browser features' },
];

function usesHelmet(ctx: ProjectContext): boolean {
  const deps = { ...(ctx.pkg?.dependencies ?? {}) };
  return 'helmet' in deps;
}

function primaryConfigFile(ctx: ProjectContext): string | undefined {
  return nextConfigFiles(ctx)[0] ?? (ctx.exists('vercel.json') ? 'vercel.json' : undefined) ?? (ctx.exists('index.html') ? 'index.html' : undefined);
}

export const missingSecurityHeadersRule = defineRule({
  id: 'security/missing-security-headers',
  title: 'Security headers not configured',
  category: 'security',
  severity: 'medium',
  why:
    'Baseline response headers block whole classes of attacks for free: clickjacking (your app framed on a phishing site), protocol downgrade, MIME sniffing. ' +
    'Security scanners and enterprise customers check for them first.',
  fix:
    'Add an `async headers()` block to next.config (or `headers` in vercel.json / `_headers` on Netlify / `helmet()` in Express) that sets ' +
    'Strict-Transport-Security, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin and Permissions-Policy.',
  appliesTo: isWebApp,
  run(ctx) {
    if (ctx.detection.frameworks.includes('express') && !isFrontend(ctx) && usesHelmet(ctx)) return [];
    const text = headerSources(ctx)
      .map((p) => ctx.read(p))
      .join('\n');
    const missing = HEADERS.filter((h) => !h.re.test(text));
    if (missing.length === 0) return [];
    if (usesHelmet(ctx) && /helmet\s*\(/.test(text)) return [];
    const file = primaryConfigFile(ctx);
    return [
      {
        severity: missing.length >= 3 ? 'medium' : 'low',
        title: `${missing.length} of ${HEADERS.length} recommended security headers missing`,
        message: `No configuration sets: ${missing.map((h) => `${h.name} (${h.purpose})`).join('; ')}.`,
        ...(file ? { file } : {}),
      },
    ];
  },
});

export const missingCspRule = defineRule({
  id: 'security/missing-csp',
  title: 'No Content-Security-Policy',
  category: 'security',
  severity: 'medium',
  why:
    'A Content-Security-Policy is the safety net when an XSS bug slips through: it stops injected scripts from loading or sending data to an attacker. ' +
    'Apps that render AI or user-generated content need it most.',
  fix:
    'Start with a report-only policy and tighten it: `Content-Security-Policy: default-src \'self\'; img-src \'self\' data: https:; connect-src \'self\' https://<project>.supabase.co; frame-ancestors \'none\'`. ' +
    'For Next.js with inline scripts, use the nonce-based middleware pattern from the Next.js CSP guide.',
  appliesTo: isWebApp,
  run(ctx) {
    const text = headerSources(ctx)
      .map((p) => ctx.read(p))
      .join('\n');
    if (/content-security-policy/i.test(text)) return [];
    if (usesHelmet(ctx) && /helmet\s*\(/.test(text) && !/contentSecurityPolicy\s*:\s*false/.test(text)) return [];
    const file = primaryConfigFile(ctx);
    return [
      {
        title: 'No Content-Security-Policy header',
        message: 'No Content-Security-Policy is set in the framework config, middleware, hosting config or HTML.',
        ...(file ? { file } : {}),
      },
    ];
  },
});

function hasAny(ctx: ProjectContext, re: RegExp): string | undefined {
  return ctx.files.find((f) => re.test(f.path))?.path;
}

export const missingRobotsRule = defineRule({
  id: 'seo/missing-robots',
  title: 'No robots.txt',
  category: 'config',
  severity: 'low',
  why: 'Without robots.txt crawlers guess; you cannot keep /dashboard or /api out of search results or point crawlers to your sitemap.',
  fix: 'Add app/robots.ts (Next.js) or public/robots.txt that disallows private paths and links the sitemap.',
  appliesTo: isFrontend,
  run(ctx) {
    const appDir = ctx.detection.appDir;
    const found =
      hasAny(ctx, /^(public\/)?robots\.txt$/) || (appDir ? hasAny(ctx, new RegExp(`^${appDir}/robots\\.(txt|[jt]sx?)$`)) : undefined);
    if (found || ctx.exists('public/robots.txt') || ctx.exists('next-sitemap.config.js')) return [];
    return [{ title: 'No robots.txt', message: 'Neither public/robots.txt nor an app/robots route exists.' }];
  },
});

export const missingSitemapRule = defineRule({
  id: 'seo/missing-sitemap',
  title: 'No sitemap',
  category: 'config',
  severity: 'low',
  why: 'A sitemap gets new pages indexed faster and is expected by Google Search Console.',
  fix: 'Add app/sitemap.ts (Next.js) or generate public/sitemap.xml at build time (e.g. vite-plugin-sitemap, next-sitemap).',
  appliesTo: isFrontend,
  run(ctx) {
    const appDir = ctx.detection.appDir;
    const deps = { ...(ctx.pkg?.dependencies ?? {}), ...(ctx.pkg?.devDependencies ?? {}) };
    if ('next-sitemap' in deps || 'vite-plugin-sitemap' in deps) return [];
    const found = hasAny(ctx, /^(public\/)?sitemap[\w-]*\.xml$/) || (appDir ? hasAny(ctx, new RegExp(`^${appDir}/sitemap\\.(xml|[jt]sx?)$`)) : undefined);
    if (found) return [];
    return [{ title: 'No sitemap', message: 'No sitemap.xml or app/sitemap route was found.' }];
  },
});

export const missingMetadataRule = defineRule({
  id: 'seo/missing-metadata',
  title: 'No page title / description metadata',
  category: 'config',
  severity: 'low',
  why: 'Search results and link previews (Slack, X, WhatsApp) use the title and description. Without them, your app shows up as "Create Next App" or a bare URL.',
  fix: 'Export `metadata` (title template, description, openGraph) from the root layout, or add `<title>` and `<meta name="description">` to index.html.',
  appliesTo: isFrontend,
  run(ctx): FindingInput[] {
    if (isNext(ctx) && ctx.detection.appDir) {
      const appDir = ctx.detection.appDir;
      const layout = ctx.files.find((f) => new RegExp(`^${appDir}/layout\\.[jt]sx?$`).test(f.path))?.path;
      if (!layout) return [];
      const code = ctx.code(layout);
      if (/export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/.test(code)) {
        if (/['"`]Create Next App['"`]/.test(code)) {
          return [{ title: 'Default "Create Next App" title', message: `${layout} still uses the create-next-app placeholder metadata.`, file: layout }];
        }
        return [];
      }
      return [{ title: 'Root layout exports no metadata', message: `${layout} exports neither \`metadata\` nor \`generateMetadata\`.`, file: layout }];
    }
    if (ctx.exists('index.html')) {
      const html = ctx.read('index.html');
      const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
      const desc = /<meta\s+name=["']description["']/i.test(html);
      const missing: string[] = [];
      if (!title || /^(Vite \+ React(?: \+ TS)?|Vite App|React App|Lovable App|Lovable Generated Project|Bolt App)$/i.test(title)) missing.push(title ? `placeholder title "${title}"` : '`<title>`');
      if (!desc) missing.push('`<meta name="description">`');
      if (missing.length > 0) return [{ title: 'index.html metadata incomplete', message: `index.html is missing ${missing.join(' and ')}.`, file: 'index.html' }];
    }
    return [];
  },
});

export const webRules = [missingSecurityHeadersRule, missingCspRule, missingRobotsRule, missingSitemapRule, missingMetadataRule];
