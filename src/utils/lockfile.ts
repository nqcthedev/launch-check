import type { PackageManager } from '../types.js';

export const LOCKFILES: Array<{ file: string; manager: PackageManager }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
];

/**
 * Extract every resolved version of the given packages from a lockfile.
 * Returns package name -> sorted unique versions. Best effort; never throws.
 */
export function lockfileVersions(lockfile: string, content: string, names: string[]): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  const add = (name: string, version: string) => {
    if (!names.includes(name)) return;
    const v = version.replace(/^v/, '').split('(')[0]!.trim();
    if (!/^\d+\.\d+\.\d+/.test(v)) return;
    if (!result.has(name)) result.set(name, new Set());
    result.get(name)!.add(v);
  };
  try {
    if (lockfile.endsWith('.json')) {
      const json = JSON.parse(content) as {
        packages?: Record<string, { version?: string }>;
        dependencies?: Record<string, { version?: string; dependencies?: unknown }>;
      };
      if (json.packages) {
        for (const [key, meta] of Object.entries(json.packages)) {
          if (!key || !meta.version) continue;
          const idx = key.lastIndexOf('node_modules/');
          if (idx === -1) continue;
          add(key.slice(idx + 'node_modules/'.length), meta.version);
        }
      } else if (json.dependencies) {
        // lockfileVersion 1
        const walk = (deps: Record<string, { version?: string; dependencies?: unknown }>) => {
          for (const [name, meta] of Object.entries(deps)) {
            if (meta.version) add(name, meta.version);
            if (meta.dependencies && typeof meta.dependencies === 'object') {
              walk(meta.dependencies as Record<string, { version?: string; dependencies?: unknown }>);
            }
          }
        };
        walk(json.dependencies);
      }
    } else if (lockfile === 'pnpm-lock.yaml') {
      // Keys under `packages:` look like "/react@18.2.0:" (v6) or "react@18.2.0:" (v9).
      const re = /^\s{2}['"]?\/?((?:@[^/\s'"]+\/)?[^@\s'"]+)@(\d[^:'"\s(]*)/gm;
      for (const m of content.matchAll(re)) add(m[1]!, m[2]!);
    } else if (lockfile === 'yarn.lock') {
      const re = /^"?((?:@[^/\s"]+\/)?[^@\s"]+)@[^\n]*:\n\s+version:? "?([^"\n]+)"?/gm;
      for (const m of content.matchAll(re)) add(m[1]!, m[2]!);
    } else if (lockfile === 'bun.lock') {
      const re = /"((?:@[^/\s"]+\/)?[^@\s"]+)":\s*\["\1@(\d[^"]*)"/g;
      for (const m of content.matchAll(re)) add(m[1]!, m[2]!);
    }
  } catch {
    // Malformed lockfile: treat as no data.
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of result) out.set(k, [...v].sort());
  return out;
}
