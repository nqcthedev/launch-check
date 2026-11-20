export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type Category =
  | 'secrets'
  | 'supabase'
  | 'firebase'
  | 'nextjs'
  | 'security'
  | 'code-quality'
  | 'dependencies'
  | 'config'
  | 'build';

export const CATEGORY_LABELS: Record<Category, string> = {
  secrets: 'Secrets & credentials',
  supabase: 'Supabase',
  firebase: 'Firebase',
  nextjs: 'Next.js',
  security: 'Application security',
  'code-quality': 'Code quality',
  dependencies: 'Dependencies',
  config: 'Configuration',
  build: 'Build',
};

export interface Location {
  file: string;
  line?: number;
  column?: number;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  category: Category;
  /** Short, specific headline for this finding. */
  title: string;
  /** One or two sentences describing this specific occurrence. */
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** The offending source line (secrets are redacted). */
  snippet?: string;
  /** Additional locations for aggregated findings (e.g. console.log count). */
  locations?: Location[];
  /** Total occurrences represented by an aggregated finding. */
  count?: number;
  why: string;
  fix: string;
  /** True when the rule is a heuristic that can produce false positives. */
  heuristic: boolean;
}

export type FindingInput = Omit<Finding, 'ruleId' | 'category' | 'why' | 'fix' | 'heuristic' | 'severity'> & {
  severity?: Severity;
  why?: string;
  fix?: string;
};

export interface RuleMeta {
  id: string;
  title: string;
  category: Category;
  /** Default severity; individual findings may override it. */
  severity: Severity;
  heuristic?: boolean;
  why: string;
  fix: string;
  docs?: string;
}

export interface Rule extends RuleMeta {
  /** Return false to skip the rule for this project (e.g. Next.js rules on a Vite app). */
  appliesTo?: (ctx: ProjectContext) => boolean;
  run: (ctx: ProjectContext) => FindingInput[] | Promise<FindingInput[]>;
}

export type Framework = 'nextjs-app' | 'nextjs-pages' | 'vite-react' | 'react-spa' | 'express' | 'node';
export type Integration = 'supabase' | 'firebase' | 'prisma' | 'drizzle' | 'stripe' | 'openai' | 'anthropic' | 'clerk' | 'next-auth';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface Detection {
  frameworks: Framework[];
  integrations: Integration[];
  packageManager: PackageManager | null;
  lockfile: string | null;
  typescript: boolean;
  /** Declared version ranges from package.json. */
  versions: Partial<Record<'next' | 'react' | 'react-dom' | 'vite', string>>;
  /** Exact versions resolved from the lockfile or node_modules, when available. */
  resolved: Partial<Record<'next' | 'react' | 'react-dom' | 'vite', string>>;
  /** Directory that contains the Next.js `app` router, relative to root (e.g. "app" or "src/app"). */
  appDir: string | null;
  pagesDir: string | null;
}

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface SourceFile {
  /** Path relative to the project root, POSIX separators. */
  path: string;
  size: number;
}

export interface ProjectContext {
  root: string;
  /** Text files that passed ignore filtering. */
  files: SourceFile[];
  pkg: PackageJson | null;
  detection: Detection;
  options: AuditOptions;
  config: ResolvedConfig;
  /** .env files found in the tree (including gitignored ones). */
  envFiles: Array<{ path: string; gitignored: boolean }>;
  read(path: string): string;
  /** Source with comments blanked out (offsets preserved). Cached. */
  code(path: string): string;
  /** Resolve a local import specifier to a project file, or null for packages / unresolvable. */
  resolveImport(fromFile: string, specifier: string): string | null;
  exists(path: string): boolean;
  /** Is this path ignored by the project's .gitignore files? */
  isGitIgnored(path: string): boolean;
  /** Files tracked by git (null if the project is not inside a git work tree or git is disabled). */
  gitTracked(): Set<string> | null;
  /** Files whose code ends up in the browser bundle (computed lazily). */
  clientFiles(): Set<string>;
  /** Import chain from a client file back to its client entry point (file first, entry last). */
  clientChain(path: string): string[];
  /** Source files (js/ts family), excluding tests and config files when requested. */
  sourceFiles(opts?: { includeTests?: boolean }): SourceFile[];
}

export interface ResolvedConfig {
  ignore: string[];
  rules: Record<string, Severity | 'off'>;
  failOn: Severity | 'none';
  consoleLogThreshold: number;
  anyDensityThreshold: number;
  configFile: string | null;
}

export interface AuditOptions {
  /** Run the project's build script and parse errors. */
  build?: boolean;
  /** Run `npm audit` / `pnpm audit` (needs network; offline-safe). */
  audit?: boolean;
  /** Use git to detect tracked files. */
  git?: boolean;
  configPath?: string;
  /** Extra ignore globs from CLI. */
  ignore?: string[];
  /** Restrict to these rule ids or categories. */
  only?: string[];
  /** Override "now" (for reproducible reports). */
  now?: Date;
  auditTimeoutMs?: number;
  buildTimeoutMs?: number;
}

export interface RuleError {
  ruleId: string;
  message: string;
}

export interface AuditResult {
  tool: { name: string; version: string };
  project: { name: string; root: string };
  generatedAt: string;
  detection: Detection;
  score: number;
  grade: string;
  counts: Record<Severity, number>;
  findings: Finding[];
  /** Rules that ran (after config / applicability filtering). */
  rulesRun: string[];
  suppressed: number;
  errors: RuleError[];
  filesScanned: number;
  durationMs: number;
  config: ResolvedConfig;
}
