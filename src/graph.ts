import { posix } from 'node:path';
import { LineIndex, hasDirective, maskSource, parseJsonc } from './utils/text.js';
import type { Detection } from './types.js';

export interface ImportRef {
  specifier: string;
  line: number;
  typeOnly: boolean;
  /** Names of a plain `{ a, b }` import clause; absent for default, namespace, side-effect and dynamic imports. */
  names?: string[];
}

const IMPORT_RES: RegExp[] = [
  /\bimport\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s*(['"])([^'"\n]+)\3/g,
  /\bexport\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s*(['"])([^'"\n]+)\3/g,
  /\bimport\s*()()(['"])([^'"\n]+)\3/g,
  /\bimport\(\s*()()(['"])([^'"\n]+)\3\s*\)/g,
  /\brequire\(\s*()()(['"])([^'"\n]+)\3\s*\)/g,
];

/**
 * `import { type A, type B } from "x"` is erased by the compiler exactly like `import type { A, B }`.
 * Returns the imported names when the clause is a plain `{ a, b as c }` list (so the caller can check
 * whether they are all types in the target module), otherwise null.
 */
function namedImports(clause: string): { names: string[]; allInlineTypes: boolean } | null {
  const m = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!m) return null;
  const parts = m[1]!.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    names: parts.map((x) => x.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()),
    allInlineTypes: parts.every((x) => /^type\s/.test(x)),
  };
}

/** True when every name is exported from `src` as a `type` or `interface` (and never as a value). */
export function exportsOnlyTypes(src: string, names: string[]): boolean {
  if (names.length === 0) return false;
  const masked = maskSource(src, { comments: true });
  return names.every((n) => {
    const id = n.replace(/[$]/g, '\\$&');
    const asType = new RegExp(String.raw`\bexport\s+(?:declare\s+)?(?:type|interface)\s+${id}\b`).test(masked);
    const asValue = new RegExp(String.raw`\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+${id}\b`).test(masked);
    return asType && !asValue;
  });
}

/** Extract static imports / re-exports / dynamic imports / requires from JS/TS source. */
export function parseImports(src: string): ImportRef[] {
  const masked = maskSource(src, { comments: true });
  const idx = new LineIndex(src);
  const refs: ImportRef[] = [];
  const seen = new Set<number>();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) {
      const at = m.index ?? 0;
      if (seen.has(at)) continue;
      seen.add(at);
      const named = m[2] ? namedImports(m[2]) : null;
      refs.push({
        specifier: m[4]!,
        line: idx.lineOf(at),
        typeOnly: Boolean(m[1]) || Boolean(named?.allInlineTypes),
        ...(named ? { names: named.names } : {}),
      });
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export interface PathAliases {
  baseUrl: string | null; // relative to root
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

export function loadPathAliases(read: (p: string) => string, exists: (p: string) => boolean): PathAliases {
  const result: PathAliases = { baseUrl: null, paths: [] };
  for (const cfg of ['tsconfig.json', 'jsconfig.json']) {
    if (!exists(cfg)) continue;
    const json = parseJsonc<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(read(cfg));
    const co = json?.compilerOptions;
    if (!co) continue;
    const base = co.baseUrl ? posix.normalize(co.baseUrl.replace(/^\.\/?/, '')) : '';
    result.baseUrl = co.baseUrl !== undefined ? (base === '.' ? '' : base) : null;
    for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
      const star = pattern.indexOf('*');
      result.paths.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? '' : pattern.slice(star + 1),
        targets: targets.map((t) => posix.join(base === '.' ? '' : base, t)),
      });
    }
    break;
  }
  // Sensible default used by create-next-app / Vite templates even without tsconfig paths.
  if (result.paths.length === 0) {
    const target = exists('src') ? 'src/*' : '*';
    result.paths.push({ prefix: '@/', suffix: '', targets: [target] });
  }
  return result;
}

export function resolveImport(
  fromFile: string,
  specifier: string,
  aliases: PathAliases,
  isFile: (p: string) => boolean,
): string | null {
  const candidates: string[] = [];
  if (specifier.startsWith('.')) {
    candidates.push(posix.normalize(posix.join(posix.dirname(fromFile), specifier)));
  } else if (specifier.startsWith('/')) {
    candidates.push(specifier.slice(1));
  } else {
    for (const p of aliases.paths) {
      if (specifier.startsWith(p.prefix) && specifier.endsWith(p.suffix)) {
        const middle = specifier.slice(p.prefix.length, specifier.length - p.suffix.length || undefined);
        for (const t of p.targets) candidates.push(posix.normalize(t.replace('*', middle)));
      }
    }
    if (aliases.baseUrl !== null) candidates.push(posix.normalize(posix.join(aliases.baseUrl, specifier)));
  }
  for (const c of candidates) {
    const clean = c.replace(/^\.\//, '');
    if (isFile(clean) && /\.[cm]?[jt]sx?$/.test(clean)) return clean;
    // ESM-style "./foo.js" that actually points at foo.ts
    const noJs = clean.replace(/\.(m|c)?js$/, '');
    for (const ext of RESOLVE_EXTS) if (isFile(noJs + ext)) return noJs + ext;
    for (const ext of RESOLVE_EXTS) if (isFile(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
  }
  return null;
}

export interface GraphInput {
  sourcePaths: string[];
  read: (p: string) => string;
  exists: (p: string) => boolean;
  detection: Detection;
  aliases: PathAliases;
}

const SOURCE_RE = /\.[cm]?[jt]sx?$/;

/** Entry points whose code is shipped to the browser. */
function clientEntries(input: GraphInput): string[] {
  const { sourcePaths, read, detection } = input;
  const entries = new Set<string>();
  const isNext = detection.frameworks.includes('nextjs-app') || detection.frameworks.includes('nextjs-pages');
  if (isNext) {
    for (const p of sourcePaths) {
      if (hasDirective(read(p), 'use client')) entries.add(p);
    }
    if (detection.pagesDir) {
      const prefix = `${detection.pagesDir}/`;
      for (const p of sourcePaths) {
        if (!p.startsWith(prefix)) continue;
        const sub = p.slice(prefix.length);
        if (sub.startsWith('api/') || /^_document\./.test(sub) || /^_middleware\./.test(sub)) continue;
        entries.add(p);
      }
    }
  }
  if (detection.frameworks.includes('vite-react') || detection.frameworks.includes('react-spa')) {
    let found = false;
    if (input.exists('index.html')) {
      const html = read('index.html');
      for (const m of html.matchAll(/<script[^>]*\bsrc=["']\/?([^"']+\.[cm]?[jt]sx?)["']/g)) {
        if (sourcePaths.includes(m[1]!)) {
          entries.add(m[1]!);
          found = true;
        }
      }
    }
    if (!found) {
      for (const p of ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.js']) {
        if (sourcePaths.includes(p)) {
          entries.add(p);
          found = true;
        }
      }
    }
    if (!found) for (const p of sourcePaths) if (p.startsWith('src/')) entries.add(p);
  }
  return [...entries];
}

/**
 * Compute the set of local source files that end up in the browser bundle,
 * by walking imports from client entry points. Traversal stops at "use server"
 * modules (calling a server action from the client does not bundle its code).
 */
export function computeClientFiles(input: GraphInput): Map<string, string | null> {
  const fileSet = new Set(input.sourcePaths.filter((p) => SOURCE_RE.test(p)));
  const isFile = (p: string) => fileSet.has(p);
  /** file -> the client module that imported it (null for entry points) */
  const parent = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = clientEntries({ ...input, sourcePaths: [...fileSet] })
    .sort()
    .map((e) => [e, null]);
  // Breadth-first so that the recorded chain is the shortest one.
  while (queue.length > 0) {
    const [file, from] = queue.shift()!;
    if (parent.has(file)) continue;
    const src = input.read(file);
    if (from !== null && hasDirective(src, 'use server')) continue;
    if (from === null && hasDirective(src, 'use server')) continue;
    parent.set(file, from);
    for (const ref of parseImports(src)) {
      if (ref.typeOnly) continue;
      const resolved = resolveImport(file, ref.specifier, input.aliases, isFile);
      if (!resolved || parent.has(resolved)) continue;
      // `import { SearchResult } from "@/app/api/search/route"`: only types cross the boundary, no code is bundled.
      if (ref.names && exportsOnlyTypes(input.read(resolved), ref.names)) continue;
      queue.push([resolved, file]);
    }
  }
  return parent;
}
