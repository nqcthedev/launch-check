import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Detection, Framework, Integration, PackageJson } from './types.js';
import { LOCKFILES, lockfileVersions } from './utils/lockfile.js';

const TRACKED = ['next', 'react', 'react-dom', 'vite'] as const;

function allDeps(pkg: PackageJson | null): Record<string, string> {
  return { ...(pkg?.peerDependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
}

function dirHasRouteFiles(dir: string): boolean {
  try {
    const stack = [dir];
    let budget = 400;
    while (stack.length > 0 && budget-- > 0) {
      const d = stack.pop()!;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) stack.push(join(d, e.name));
        else if (/^(page|layout|route|index|_app)\.[jt]sx?$/.test(e.name) || /\.[jt]sx?$/.test(e.name)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function detectProject(root: string, pkg: PackageJson | null, sourcePaths: string[]): Detection {
  const deps = allDeps(pkg);
  const has = (name: string) => name in deps;
  const hasPrefix = (prefix: string) => Object.keys(deps).some((d) => d.startsWith(prefix));
  const frameworks: Framework[] = [];
  let appDir: string | null = null;
  let pagesDir: string | null = null;

  if (has('next')) {
    for (const candidate of ['src/app', 'app']) {
      if (isDir(join(root, candidate)) && dirHasRouteFiles(join(root, candidate))) {
        appDir = candidate;
        break;
      }
    }
    for (const candidate of ['src/pages', 'pages']) {
      if (isDir(join(root, candidate)) && dirHasRouteFiles(join(root, candidate))) {
        pagesDir = candidate;
        break;
      }
    }
    if (appDir) frameworks.push('nextjs-app');
    if (pagesDir) frameworks.push('nextjs-pages');
    if (!appDir && !pagesDir) frameworks.push('nextjs-app');
  } else if (has('vite') && (has('react') || has('@vitejs/plugin-react') || has('@vitejs/plugin-react-swc'))) {
    frameworks.push('vite-react');
  } else if (has('react-scripts')) {
    frameworks.push('react-spa');
  }

  if (has('express') || has('fastify') || has('koa') || has('hono') || has('@hono/node-server')) {
    frameworks.push('express');
  }
  if (frameworks.length === 0 && pkg) frameworks.push('node');

  const integrations: Integration[] = [];
  const usesSupabase =
    hasPrefix('@supabase/') || existsSync(join(root, 'supabase', 'migrations')) || existsSync(join(root, 'supabase', 'config.toml'));
  if (usesSupabase) integrations.push('supabase');
  if (has('firebase') || has('firebase-admin') || existsSync(join(root, 'firebase.json')) || existsSync(join(root, 'firestore.rules'))) {
    integrations.push('firebase');
  }
  if (has('prisma') || has('@prisma/client') || sourcePaths.some((p) => p.endsWith('schema.prisma'))) integrations.push('prisma');
  if (has('drizzle-orm')) integrations.push('drizzle');
  if (has('stripe') || hasPrefix('@stripe/')) integrations.push('stripe');
  if (has('openai') || has('@ai-sdk/openai')) integrations.push('openai');
  if (has('@anthropic-ai/sdk') || has('@ai-sdk/anthropic')) integrations.push('anthropic');
  if (hasPrefix('@clerk/')) integrations.push('clerk');
  if (has('next-auth') || hasPrefix('@auth/')) integrations.push('next-auth');

  let lockfile: string | null = null;
  let packageManager: Detection['packageManager'] = null;
  for (const l of LOCKFILES) {
    if (existsSync(join(root, l.file))) {
      lockfile = l.file;
      packageManager = l.manager;
      break;
    }
  }
  if (!packageManager && typeof pkg?.packageManager === 'string') {
    const pm = pkg.packageManager.split('@')[0];
    if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn' || pm === 'bun') packageManager = pm;
  }

  const versions: Detection['versions'] = {};
  for (const name of TRACKED) if (deps[name]) versions[name] = deps[name];

  const resolved: Detection['resolved'] = {};
  for (const name of TRACKED) {
    try {
      const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string };
      if (installed.version) resolved[name] = installed.version;
    } catch {
      // not installed
    }
  }
  if (lockfile && lockfile !== 'bun.lockb') {
    try {
      const fromLock = lockfileVersions(lockfile, readFileSync(join(root, lockfile), 'utf8'), [...TRACKED]);
      for (const name of TRACKED) {
        const vs = fromLock.get(name);
        if (!resolved[name] && vs && vs.length > 0) resolved[name] = vs[vs.length - 1]!;
      }
    } catch {
      // unreadable lockfile
    }
  }

  const typescript = has('typescript') || existsSync(join(root, 'tsconfig.json')) || sourcePaths.some((p) => /\.tsx?$/.test(p));

  return { frameworks, integrations, packageManager, lockfile, typescript, versions, resolved, appDir, pagesDir };
}

export function describeStack(d: Detection): string {
  const names: Record<string, string> = {
    'nextjs-app': 'Next.js (App Router)',
    'nextjs-pages': 'Next.js (Pages Router)',
    'vite-react': 'Vite + React',
    'react-spa': 'React (CRA)',
    express: 'Node server (Express/Fastify/Hono)',
    node: 'Node.js',
  };
  const integ: Record<string, string> = {
    supabase: 'Supabase',
    firebase: 'Firebase',
    prisma: 'Prisma',
    drizzle: 'Drizzle',
    stripe: 'Stripe',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    clerk: 'Clerk',
    'next-auth': 'Auth.js',
  };
  const parts = d.frameworks.map((f) => names[f] ?? f);
  const version = d.resolved.next ?? d.versions.next;
  if (version && parts.length > 0 && parts[0]!.startsWith('Next.js')) parts[0] = parts[0]!.replace('Next.js', `Next.js ${version.replace(/^[\^~]/, '')}`);
  const ints = d.integrations.map((i) => integ[i] ?? i);
  return [parts.join(' + ') || 'Unknown', ints.length ? ints.join(', ') : ''].filter(Boolean).join(' · ');
}
