import { execFile } from 'node:child_process';
import type { FindingInput, ProjectContext, Severity } from '../types.js';
import { lockfileVersions } from '../utils/lockfile.js';
import { compareVersions, formatVersion, isNonRegistryRange, isUnpinnedRange, parseVersion } from '../utils/version.js';
import { defineRule, isNext, matchAll, middlewareFiles, plural } from './helpers.js';

const hasDeps = (ctx: ProjectContext) =>
  Boolean(ctx.pkg && Object.keys({ ...(ctx.pkg.dependencies ?? {}), ...(ctx.pkg.devDependencies ?? {}) }).length > 0);

function pkgLine(ctx: ProjectContext, name: string): { line?: number; snippet?: string } {
  const text = ctx.read('package.json');
  const m = matchAll(text, text, new RegExp(`"${name.replace(/[/.]/g, '\\$&')}"\\s*:`, 'g'))[0];
  return m ? { line: m.line, snippet: m.snippet } : {};
}

export const missingLockfileRule = defineRule({
  id: 'dependencies/missing-lockfile',
  title: 'No lockfile committed',
  category: 'dependencies',
  severity: 'medium',
  why:
    'Without a lockfile every install resolves fresh versions, so production can run different code than you tested, and a compromised ' +
    'or broken patch release ships automatically.',
  fix: 'Run your package manager once (`npm install`, `pnpm install`) and commit the generated lockfile; use `npm ci` / `pnpm install --frozen-lockfile` in CI and deploys.',
  appliesTo: hasDeps,
  run(ctx) {
    if (ctx.detection.lockfile) return [];
    return [{ title: 'No lockfile', message: 'package.json declares dependencies but no package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock is present.', file: 'package.json' }];
  },
});

export const unpinnedRule = defineRule({
  id: 'dependencies/unpinned-version',
  title: 'Dependency on "latest" or an open-ended range',
  category: 'dependencies',
  severity: 'medium',
  why: '"latest", "*" and ">=" ranges pull in new major versions with breaking changes on the next install, often in the middle of a deploy.',
  fix: 'Pin to a caret range of the version you tested (`npm install next@15.5.4` writes "^15.5.4").',
  appliesTo: hasDeps,
  run(ctx) {
    const deps = { ...(ctx.pkg?.devDependencies ?? {}), ...(ctx.pkg?.dependencies ?? {}) };
    const bad = Object.entries(deps).filter(([, range]) => !isNonRegistryRange(range) && isUnpinnedRange(range));
    if (bad.length === 0) return [];
    const loc = pkgLine(ctx, bad[0]![0]);
    return [
      {
        title: `${plural(bad.length, 'dependency', 'dependencies')} not pinned`,
        message: `${bad.map(([n, r]) => `${n}@"${r}"`).join(', ')}.`,
        file: 'package.json',
        ...loc,
      },
    ];
  },
});

export const reactVersionsRule = defineRule({
  id: 'dependencies/react-version-mismatch',
  title: 'Mismatched or duplicate React versions',
  category: 'dependencies',
  severity: 'high',
  why:
    'react and react-dom must be the exact same version; a mismatch or two copies of React in the bundle cause "Invalid hook call" crashes ' +
    'and hydration errors that only show up in production builds.',
  fix: 'Install matching versions (`npm install react@X react-dom@X`), then `npm dedupe` and check `npm ls react`.',
  appliesTo: (ctx) => Boolean(ctx.pkg?.dependencies?.react || ctx.pkg?.dependencies?.['react-dom']),
  run(ctx) {
    const out: FindingInput[] = [];
    const deps = { ...(ctx.pkg?.devDependencies ?? {}), ...(ctx.pkg?.dependencies ?? {}) };
    const react = deps.react;
    const dom = deps['react-dom'];
    if (react && dom) {
      const rv = parseVersion(react);
      const dv = parseVersion(dom);
      const unknown = isUnpinnedRange(react) !== isUnpinnedRange(dom);
      if (unknown || (rv && dv && (rv.major !== dv.major || rv.minor !== dv.minor))) {
        out.push({
          title: `react "${react}" and react-dom "${dom}" do not match`,
          message: `package.json declares react@"${react}" but react-dom@"${dom}"; they can resolve to different versions.`,
          file: 'package.json',
          ...pkgLine(ctx, 'react-dom'),
        });
      }
    }
    const lock = ctx.detection.lockfile;
    if (lock && lock !== 'bun.lockb') {
      const versions = lockfileVersions(lock, ctx.read(lock), ['react', 'react-dom']);
      for (const name of ['react', 'react-dom']) {
        const vs = versions.get(name) ?? [];
        const majors = new Set(vs.map((v) => v.split('.')[0]));
        if (majors.size > 1) {
          out.push({
            severity: 'medium',
            title: `${name} installed in ${vs.length} versions`,
            message: `${lock} resolves ${name} to ${vs.join(', ')}. Two copies of ${name} in one bundle break hooks.`,
            file: lock,
          });
        }
      }
    }
    return out;
  },
});

/** Latest major versions known at release time of this launch-check version. */
export const KNOWN_LATEST = { next: 16, react: 19 } as const;

function effectiveVersion(ctx: ProjectContext, name: 'next' | 'react'): { version: string; exact: boolean } | null {
  const resolved = ctx.detection.resolved[name];
  if (resolved) return { version: resolved, exact: true };
  const declared = ctx.detection.versions[name];
  if (!declared || isNonRegistryRange(declared) || isUnpinnedRange(declared)) return null;
  return { version: declared, exact: /^\d/.test(declared.trim()) };
}

export const outdatedFrameworkRule = defineRule({
  id: 'dependencies/outdated-framework',
  title: 'Framework major version is out of support',
  category: 'dependencies',
  severity: 'medium',
  why: 'Old majors stop receiving security patches, and every month behind makes the eventual upgrade larger. Security fixes for Next.js land only on recent majors.',
  fix: 'Upgrade one major at a time with the official codemods (`npx @next/codemod@latest upgrade`), running the build and tests between steps.',
  appliesTo: (ctx) => Boolean(ctx.detection.versions.next || ctx.detection.versions.react),
  run(ctx) {
    const out: FindingInput[] = [];
    for (const name of ['next', 'react'] as const) {
      const eff = effectiveVersion(ctx, name);
      const v = parseVersion(eff?.version);
      if (!eff || !v) continue;
      const behind = KNOWN_LATEST[name] - v.major;
      if (behind < 2) continue;
      const severity: Severity = name === 'next' && v.major <= 13 ? 'high' : 'medium';
      out.push({
        severity,
        title: `${name} ${formatVersion(v)} is ${behind} major versions behind`,
        message: `${name} ${formatVersion(v)} is in use; the current major is ${KNOWN_LATEST[name]}.`,
        file: 'package.json',
        ...pkgLine(ctx, name),
      });
    }
    return out;
  },
});

/** CVE-2025-29927: middleware authorization bypass via the x-middleware-subrequest header. */
const MIDDLEWARE_BYPASS_FIXED: Array<[number, string]> = [
  [12, '12.3.5'],
  [13, '13.5.9'],
  [14, '14.2.25'],
  [15, '15.2.3'],
];

export const nextMiddlewareCveRule = defineRule({
  id: 'dependencies/next-middleware-bypass',
  title: 'Next.js version vulnerable to middleware bypass (CVE-2025-29927)',
  category: 'dependencies',
  severity: 'critical',
  why:
    'In affected Next.js versions an attacker can skip middleware entirely by sending an `x-middleware-subrequest` header. ' +
    'If middleware is where you check authentication, every "protected" page is public.',
  fix: 'Upgrade Next.js to 12.3.5, 13.5.9, 14.2.25, 15.2.3 or later, and re-check auth inside pages/route handlers instead of relying on middleware alone.',
  docs: 'https://github.com/advisories/GHSA-f82v-jwr5-mffw',
  appliesTo: isNext,
  run(ctx) {
    const mw = middlewareFiles(ctx);
    if (mw.length === 0) return [];
    const eff = effectiveVersion(ctx, 'next');
    // With a caret range and no lockfile we cannot know the installed version: do not guess.
    if (!eff || !eff.exact) return [];
    const v = parseVersion(eff.version);
    if (!v || v.major < 11 || (v.major === 11 && (v.minor < 1 || (v.minor === 1 && v.patch < 4)))) return [];
    const fixed = MIDDLEWARE_BYPASS_FIXED.find(([major]) => major === v.major)?.[1] ?? (v.major === 11 ? '12.3.5' : null);
    if (!fixed) return [];
    const fixedV = parseVersion(fixed)!;
    if (v.major === 11 || compareVersions(v, fixedV) < 0) {
      const authInMiddleware = /auth|session|getUser|redirect/i.test(ctx.code(mw[0]!));
      return [
        {
          severity: authInMiddleware ? 'critical' : 'high',
          title: `next ${formatVersion(v)} allows bypassing ${mw[0]}`,
          message:
            `next ${formatVersion(v)} is affected by CVE-2025-29927 (fixed in ${fixed}) and the project uses ${mw[0]}` +
            (authInMiddleware ? ', which performs auth checks.' : '.'),
          file: 'package.json',
          ...pkgLine(ctx, 'next'),
        },
      ];
    }
    return [];
  },
});

/* ------------------------------------------------------------------------------------------------ */
/* npm / pnpm audit                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

const AUDIT_SEVERITY: Record<string, Severity> = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', info: 'info' };

export interface AuditAdvisory {
  name: string;
  severity: Severity;
  title: string;
  url?: string;
  range?: string;
  fixAvailable?: boolean | string;
  direct?: boolean;
}

/** Parse `npm audit --json` (v7+) or `pnpm audit --json` output. */
export function parseAuditJson(raw: string): AuditAdvisory[] | null {
  let json: Record<string, unknown>;
  try {
    const start = raw.indexOf('{');
    json = JSON.parse(start > 0 ? raw.slice(start) : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: AuditAdvisory[] = [];
  if (json.vulnerabilities && typeof json.vulnerabilities === 'object') {
    for (const [name, vRaw] of Object.entries(json.vulnerabilities as Record<string, Record<string, unknown>>)) {
      const via = Array.isArray(vRaw.via) ? (vRaw.via as unknown[]) : [];
      const own = via.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
      if (own.length === 0) continue; // only transitively vulnerable through another package
      const worst = own[0]!;
      const fix = vRaw.fixAvailable;
      out.push({
        name,
        severity: AUDIT_SEVERITY[String(vRaw.severity)] ?? 'medium',
        title: own.length > 1 ? `${String(worst.title)} (+${own.length - 1} more)` : String(worst.title),
        ...(typeof worst.url === 'string' ? { url: worst.url } : {}),
        ...(typeof vRaw.range === 'string' ? { range: vRaw.range } : {}),
        fixAvailable: typeof fix === 'object' && fix !== null ? `${String((fix as Record<string, unknown>).name)}@${String((fix as Record<string, unknown>).version)}` : Boolean(fix),
        direct: Boolean(vRaw.isDirect),
      });
    }
    return out;
  }
  if (json.advisories && typeof json.advisories === 'object') {
    for (const a of Object.values(json.advisories as Record<string, Record<string, unknown>>)) {
      out.push({
        name: String(a.module_name),
        severity: AUDIT_SEVERITY[String(a.severity)] ?? 'medium',
        title: String(a.title),
        ...(typeof a.url === 'string' ? { url: a.url } : {}),
        ...(typeof a.vulnerable_versions === 'string' ? { range: a.vulnerable_versions } : {}),
        fixAvailable: typeof a.patched_versions === 'string' && a.patched_versions !== '<0.0.0' ? `patched in ${a.patched_versions}` : false,
      });
    }
    return out;
  }
  if (json.error) return null;
  return out;
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, npm_config_fund: 'false' } }, (err, stdout) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? null : 0;
      resolve({ stdout: stdout?.toString() ?? '', code, ...(err && !stdout ? { error: err.message } : {}) });
    });
  });
}

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const auditRule = defineRule({
  id: 'dependencies/vulnerable-packages',
  title: 'Dependencies with known vulnerabilities',
  category: 'dependencies',
  severity: 'high',
  why: 'Published advisories come with public exploit details; automated scanners probe deployed apps for them within days.',
  fix: 'Run `npm audit fix` (or upgrade the listed packages to the patched version), re-run the build and tests, and commit the lockfile.',
  appliesTo: (ctx) =>
    ctx.options.audit !== false && (ctx.detection.lockfile === 'package-lock.json' || ctx.detection.lockfile === 'pnpm-lock.yaml' || ctx.detection.lockfile === 'npm-shrinkwrap.json'),
  async run(ctx) {
    const pnpm = ctx.detection.lockfile === 'pnpm-lock.yaml';
    const cmd = pnpm ? 'pnpm' : 'npm';
    const args = pnpm ? ['audit', '--json', '--prod'] : ['audit', '--json', '--omit=dev'];
    const res = await runCommand(cmd, args, ctx.root, ctx.options.auditTimeoutMs ?? 30_000);
    const advisories = parseAuditJson(res.stdout);
    if (!advisories) {
      return [
        {
          severity: 'info',
          title: `${cmd} audit could not run`,
          message: `\`${cmd} ${args.join(' ')}\` did not return a report (offline, registry unreachable, or ${cmd} not installed). Dependency vulnerabilities were not checked.`,
          file: ctx.detection.lockfile ?? 'package.json',
        },
      ];
    }
    advisories.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || (a.name < b.name ? -1 : 1));
    const shown = advisories.slice(0, 15);
    const out: FindingInput[] = shown.map((a) => ({
      severity: a.severity,
      title: `${a.name}${a.range ? ` ${a.range}` : ''}: ${a.title}`,
      message:
        `${a.direct ? 'Direct dependency' : 'Dependency'} ${a.name} has a ${a.severity} advisory${a.url ? ` (${a.url})` : ''}.` +
        (typeof a.fixAvailable === 'string' ? ` Fix: ${a.fixAvailable}.` : a.fixAvailable ? ' `npm audit fix` can resolve it.' : ' No fix available yet.'),
      file: ctx.detection.lockfile ?? 'package.json',
    }));
    if (advisories.length > shown.length) {
      out.push({
        severity: 'info',
        title: `${advisories.length - shown.length} more advisories`,
        message: `Run \`${cmd} audit\` for the full list.`,
        file: ctx.detection.lockfile ?? 'package.json',
      });
    }
    return out;
  },
});

export const depRules = [missingLockfileRule, unpinnedRule, reactVersionsRule, outdatedFrameworkRule, nextMiddlewareCveRule, auditRule];
export { runCommand };
