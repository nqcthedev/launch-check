import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from './detect.js';
import { computeClientFiles, loadPathAliases, resolveImport } from './graph.js';
import type { AuditOptions, PackageJson, ProjectContext, ResolvedConfig, SourceFile } from './types.js';
import { parseJsonc, maskSource } from './utils/text.js';
import { walkProject } from './walker.js';

const SOURCE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const TEST_RE = /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright|spec|fixtures|stories)\/|\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$/;

export function isTestPath(path: string): boolean {
  return TEST_RE.test(path);
}

function gitTrackedFiles(root: string): Set<string> | null {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (inside !== 'true') return null;
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

export function createContext(root: string, options: AuditOptions, config: ResolvedConfig): ProjectContext {
  const ignores = [...config.ignore, ...(options.ignore ?? [])];
  const walk = walkProject(root, ignores);
  const cache = new Map<string, string>();
  const codeCache = new Map<string, string>();
  const fileSet = new Set(walk.files.map((f) => f.path));

  const read = (path: string): string => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    let text = '';
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      text = '';
    }
    cache.set(path, text);
    return text;
  };
  const exists = (path: string) => fileSet.has(path) || existsSync(join(root, path));

  let pkg: PackageJson | null = null;
  if (existsSync(join(root, 'package.json'))) {
    pkg = parseJsonc<PackageJson>(read('package.json'));
  }
  const detection = detectProject(root, pkg, walk.files.map((f) => f.path));
  const aliases = loadPathAliases(read, exists);

  let tracked: Set<string> | null | undefined;
  let clientMap: Map<string, string | null> | undefined;
  const getClientMap = () => {
    if (!clientMap) {
      clientMap = computeClientFiles({
        sourcePaths: walk.files.map((f) => f.path),
        read,
        exists,
        detection,
        aliases,
      });
    }
    return clientMap;
  };

  const sourceFiles = (opts?: { includeTests?: boolean }): SourceFile[] =>
    walk.files.filter((f) => SOURCE_RE.test(f.path) && (opts?.includeTests || !isTestPath(f.path)));

  const ctx: ProjectContext = {
    root,
    files: walk.files,
    pkg,
    detection,
    options,
    config,
    envFiles: walk.envFiles,
    read,
    exists,
    code(path) {
      const hit = codeCache.get(path);
      if (hit !== undefined) return hit;
      const masked = maskSource(read(path), { comments: true });
      codeCache.set(path, masked);
      return masked;
    },
    resolveImport(fromFile, specifier) {
      return resolveImport(fromFile, specifier, aliases, (p) => fileSet.has(p));
    },
    isGitIgnored: walk.isGitIgnored,
    gitTracked() {
      if (options.git === false) return null;
      if (tracked === undefined) tracked = gitTrackedFiles(root);
      return tracked;
    },
    clientFiles() {
      return new Set(getClientMap().keys());
    },
    clientChain(path) {
      const map = getClientMap();
      const chain: string[] = [];
      let cur: string | null | undefined = path;
      while (cur && chain.length < 20) {
        chain.push(cur);
        cur = map.get(cur);
      }
      return chain;
    },
    sourceFiles,
  };
  return ctx;
}
