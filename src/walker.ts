import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { SourceFile } from './types.js';

/** Directories that never contain first-party source and are expensive to walk. */
export const ALWAYS_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.vercel',
  '.netlify',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.expo',
  '.wrangler',
  '.idea',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
  '.venv',
  'venv',
  '__pycache__',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.jsonc', '.sql', '.yml', '.yaml', '.toml', '.html', '.vue', '.svelte', '.astro',
  '.rules', '.prisma', '.txt', '.xml', '.graphql', '.gql', '.sh',
]);

const TEXT_BASENAMES = new Set(['Dockerfile', '.npmrc', '.yarnrc', 'Procfile', 'vercel.json', 'netlify.toml']);

export const MAX_FILE_BYTES = 1024 * 1024;

export interface EnvFile {
  path: string;
  gitignored: boolean;
}

export interface WalkResult {
  files: SourceFile[];
  envFiles: EnvFile[];
  /** Matcher for .gitignore rules (root + nested). */
  isGitIgnored: (path: string) => boolean;
}

function extname(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

export function isEnvFileName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

function isTextCandidate(name: string): boolean {
  if (isEnvFileName(name)) return true;
  if (TEXT_BASENAMES.has(name)) return true;
  if (/\.min\.(js|css)$/.test(name) || /\.map$/.test(name)) return false;
  if (name.endsWith('.d.ts')) return false;
  if (name === 'package-lock.json' || name === 'pnpm-lock.yaml' || name === 'yarn.lock' || name === 'bun.lock') return false;
  return TEXT_EXTENSIONS.has(extname(name));
}

interface GitignoreScope {
  base: string; // directory relative to root ('' for root)
  ig: Ignore;
}

function loadGitignore(absDir: string, relDir: string): GitignoreScope | null {
  try {
    const content = readFileSync(join(absDir, '.gitignore'), 'utf8');
    return { base: relDir, ig: ignore().add(content) };
  } catch {
    return null;
  }
}

function ignoredByScopes(scopes: GitignoreScope[], relPath: string, isDir: boolean): boolean {
  for (const scope of scopes) {
    const sub = scope.base ? relPath.slice(scope.base.length + 1) : relPath;
    if (!sub) continue;
    if (scope.ig.ignores(isDir ? `${sub}/` : sub)) return true;
  }
  return false;
}

/**
 * Walk a project directory, honouring .gitignore files (root and nested) and extra ignore globs.
 * Env files are reported separately even when gitignored, because "is it ignored?" is the question.
 */
export function walkProject(root: string, extraIgnores: string[] = []): WalkResult {
  const files: SourceFile[] = [];
  const envFiles: EnvFile[] = [];
  const extra = ignore().add(extraIgnores);
  const allScopes: GitignoreScope[] = [];

  const visit = (absDir: string, relDir: string, scopes: GitignoreScope[]) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const local = loadGitignore(absDir, relDir);
    const active = local ? [...scopes, local] : scopes;
    if (local) allScopes.push(local);

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relDir ? posix.join(relDir, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (extra.ignores(`${rel}/`)) continue;
        if (ignoredByScopes(active, rel, true)) continue;
        visit(join(absDir, entry.name), rel, active);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extra.ignores(rel)) continue;
      const gitignored = ignoredByScopes(active, rel, false);
      if (isEnvFileName(entry.name)) {
        envFiles.push({ path: rel, gitignored });
      }
      if (gitignored) continue;
      if (!isTextCandidate(entry.name)) continue;
      let size = 0;
      try {
        size = statSync(join(absDir, entry.name)).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      files.push({ path: rel, size });
    }
  };

  visit(root, '', []);

  const isGitIgnored = (relPath: string): boolean => {
    const parts = relPath.split('/');
    // A path is ignored if it, or any parent directory, matches.
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const isDir = i < parts.length;
      const scopes = allScopes.filter((s) => s.base === '' || prefix === s.base || prefix.startsWith(`${s.base}/`));
      if (ignoredByScopes(scopes, prefix, isDir)) return true;
    }
    return false;
  };

  return { files, envFiles, isGitIgnored };
}
