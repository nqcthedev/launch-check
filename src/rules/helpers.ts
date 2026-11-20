import type { FindingInput, ProjectContext, Rule } from '../types.js';
import { LineIndex, maskSource, snippetOf } from '../utils/text.js';

export function defineRule(rule: Rule): Rule {
  return rule;
}

export interface Match {
  index: number;
  line: number;
  column: number;
  text: string;
  groups: string[];
  snippet: string;
}

/** Run a global regex over `haystack` (usually comment-masked code) and map hits to lines of `original`. */
export function matchAll(original: string, haystack: string, re: RegExp): Match[] {
  if (!re.global) throw new Error(`regex must be global: ${re}`);
  const idx = new LineIndex(original);
  const out: Match[] = [];
  re.lastIndex = 0;
  for (const m of haystack.matchAll(re)) {
    const at = m.index ?? 0;
    const line = idx.lineOf(at);
    out.push({
      index: at,
      line,
      column: idx.columnOf(at),
      text: m[0],
      groups: m.slice(1).map((g) => g ?? ''),
      snippet: snippetOf(idx.line(line)),
    });
  }
  return out;
}

export function lineAt(text: string, line: number): string {
  return snippetOf(new LineIndex(text).line(line));
}

export interface EnvRef {
  name: string;
  index: number;
  line: number;
  style: 'process.env' | 'import.meta.env';
}

const ENV_REF_RE = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)|\bprocess\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;

/** Find environment variable reads in comment-masked code (mentions inside string literals are ignored). */
export function envRefs(code: string, original: string): EnvRef[] {
  const idx = new LineIndex(original);
  const refs: EnvRef[] = [];
  const structural = maskSource(original, { comments: true, strings: true });
  ENV_REF_RE.lastIndex = 0;
  for (const m of code.matchAll(ENV_REF_RE)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (!name) continue;
    const at = m.index ?? 0;
    if (structural[at] !== original[at]) continue; // inside a string or template text
    refs.push({ name, index: at, line: idx.lineOf(at), style: m[3] ? 'import.meta.env' : 'process.env' });
  }
  // Destructuring: const { FOO, BAR } = process.env
  for (const m of code.matchAll(/\{([^}]{1,400})\}\s*=\s*(process\.env|import\.meta\.env)\b/g)) {
    const at = m.index ?? 0;
    for (const part of m[1]!.split(',')) {
      const name = part.split(':')[0]!.split('=')[0]!.trim();
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        refs.push({ name, index: at, line: idx.lineOf(at), style: m[2] === 'import.meta.env' ? 'import.meta.env' : 'process.env' });
      }
    }
  }
  return refs;
}

export interface EnvEntry {
  name: string;
  value: string;
  line: number;
}

/** Parse a dotenv file (KEY=value, optional `export`, quotes, comments). */
export function parseDotenv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) return;
    let value = m[2]!.trim();
    const q = value[0];
    if ((q === '"' || q === "'" || q === '`') && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    entries.push({ name: m[1]!, value, line: i + 1 });
  });
  return entries;
}

export const ENV_TEMPLATE_RE = /(^|\/)\.env\.(example|sample|template|dist|defaults|schema)$|\.example$|\.sample$|\.template$/;

export function isEnvTemplate(path: string): boolean {
  return ENV_TEMPLATE_RE.test(path);
}

export function isSourcePath(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path);
}

export function isConfigFile(path: string): boolean {
  return /(^|\/)[\w.-]+\.config\.[cm]?[jt]s$/.test(path) || /(^|\/)(\.eslintrc|\.prettierrc)/.test(path);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function finding(input: FindingInput): FindingInput {
  return input;
}

/** All Next.js config files present in the project root. */
export function nextConfigFiles(ctx: ProjectContext): string[] {
  return ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs', 'next.config.mts'].filter((f) => ctx.exists(f));
}

/** middleware.ts (Next <=15) or proxy.ts (Next 16+), at root or in src/. */
export function middlewareFiles(ctx: ProjectContext): string[] {
  const out: string[] = [];
  for (const base of ['', 'src/']) {
    for (const name of ['middleware', 'proxy']) {
      for (const ext of ['ts', 'js', 'mjs', 'tsx', 'jsx']) {
        const p = `${base}${name}.${ext}`;
        if (ctx.files.some((f) => f.path === p)) out.push(p);
      }
    }
  }
  return out;
}

export const isNext = (ctx: ProjectContext) =>
  ctx.detection.frameworks.includes('nextjs-app') || ctx.detection.frameworks.includes('nextjs-pages');

export const isWebApp = (ctx: ProjectContext) =>
  isNext(ctx) ||
  ctx.detection.frameworks.includes('vite-react') ||
  ctx.detection.frameworks.includes('react-spa') ||
  ctx.detection.frameworks.includes('express');

export const isFrontend = (ctx: ProjectContext) =>
  isNext(ctx) || ctx.detection.frameworks.includes('vite-react') || ctx.detection.frameworks.includes('react-spa');
