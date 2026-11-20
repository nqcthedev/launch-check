import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { allRules } from './rules/index.js';
import { computeScore, gradeFor } from './score.js';
import {
  SEVERITIES,
  type AuditOptions,
  type AuditResult,
  type Category,
  type Finding,
  type ProjectContext,
  type Rule,
  type RuleError,
  type Severity,
} from './types.js';
import { LineIndex, snippetOf } from './utils/text.js';
import { TOOL_NAME, VERSION } from './version.js';

const CATEGORY_ORDER: Category[] = ['secrets', 'supabase', 'firebase', 'security', 'nextjs', 'dependencies', 'build', 'config', 'code-quality'];

export function selectRules(rules: Rule[], ctx: ProjectContext): Rule[] {
  const only = ctx.options.only?.map((s) => s.trim()).filter(Boolean) ?? [];
  return rules.filter((rule) => {
    if (ctx.config.rules[rule.id] === 'off') return false;
    if (only.length > 0 && !only.some((o) => rule.id === o || rule.category === o || rule.id.startsWith(`${o}/`))) return false;
    return true;
  });
}

const SUPPRESS_RE = /launch-check-(ignore|disable)(-next-line|-line|-file)?(?:\s+([\w/@.,\s-]+))?/;

/** Inline suppressions: `// launch-check-ignore-next-line rule-id`, `// launch-check-ignore` (same line), `launch-check-ignore-file`. */
function isSuppressed(ctx: ProjectContext, f: Finding, cache: Map<string, LineIndex>): boolean {
  if (!f.file || /(^|\/)\.env/.test(f.file)) return false;
  let idx = cache.get(f.file);
  if (!idx) {
    const text = ctx.read(f.file);
    if (!text.includes('launch-check-')) return false;
    idx = new LineIndex(text);
    cache.set(f.file, idx);
  }
  const matches = (text: string, kinds: Array<string | undefined>): boolean => {
    const m = SUPPRESS_RE.exec(text);
    if (!m || !kinds.includes(m[2])) return false;
    const ids = m[3]?.split(/[\s,]+/).filter((s) => s.includes('/')) ?? [];
    return ids.length === 0 || ids.includes(f.ruleId);
  };
  for (let l = 1; l <= Math.min(idx.lineCount, 10); l++) if (matches(idx.line(l), ['-file'])) return true;
  if (!f.line) return false;
  if (matches(idx.line(f.line), [undefined, '-line'])) return true;
  if (f.line > 1 && matches(idx.line(f.line - 1), ['-next-line'])) return true;
  return false;
}

const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

export async function audit(rootInput: string, options: AuditOptions = {}): Promise<AuditResult> {
  const started = Date.now();
  const root = resolve(rootInput);
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new Error(`Path not found: ${rootInput}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${rootInput}`);

  const config = loadConfig(root, options.configPath);
  const ctx = createContext(root, options, config);
  const selected = selectRules(allRules, ctx);
  const findings: Finding[] = [];
  const errors: RuleError[] = [];
  const rulesRun: string[] = [];
  const indexCache = new Map<string, LineIndex>();
  let suppressed = 0;

  for (const rule of selected) {
    try {
      if (rule.appliesTo && !rule.appliesTo(ctx)) continue;
      rulesRun.push(rule.id);
      const raw = await rule.run(ctx);
      for (const input of raw) {
        const override = config.rules[rule.id];
        const severity: Severity = override && override !== 'off' ? override : (input.severity ?? rule.severity);
        const f: Finding = {
          ...input,
          ruleId: rule.id,
          category: rule.category,
          severity,
          why: input.why ?? rule.why,
          fix: input.fix ?? rule.fix,
          heuristic: rule.heuristic ?? false,
        };
        if (f.file && f.line && !f.snippet && !/(^|\/)\.env/.test(f.file)) {
          const text = ctx.read(f.file);
          if (text) f.snippet = snippetOf(new LineIndex(text).line(f.line));
        }
        if (isSuppressed(ctx, f, indexCache)) {
          suppressed++;
          continue;
        }
        findings.push(f);
      }
    } catch (err) {
      errors.push({ ruleId: rule.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const sorted = sortFindings(findings);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of sorted) counts[f.severity]++;
  const score = computeScore(sorted);
  const now = options.now ?? new Date();

  return {
    tool: { name: TOOL_NAME, version: VERSION },
    project: { name: (typeof ctx.pkg?.name === 'string' && ctx.pkg.name) || basename(root), root },
    generatedAt: now.toISOString(),
    detection: ctx.detection,
    score,
    grade: gradeFor(score, sorted),
    counts,
    findings: sorted,
    rulesRun,
    suppressed,
    errors,
    filesScanned: ctx.files.length,
    durationMs: Date.now() - started,
    config,
  };
}

/** Does the result contain a finding at or above the threshold? */
export function exceedsThreshold(result: AuditResult, failOn: Severity | 'none'): boolean {
  if (failOn === 'none') return false;
  const limit = SEV_RANK[failOn];
  return result.findings.some((f) => SEV_RANK[f.severity] <= limit);
}
