import pc from 'picocolors';
import { describeStack } from '../detect.js';
import { CATEGORY_LABELS, SEVERITIES, type AuditResult, type Category, type Finding, type Severity } from '../types.js';
import { location, verdict } from './common.js';

type Colors = ReturnType<typeof pc.createColors>;

export interface TerminalOptions {
  color?: boolean;
  width?: number;
  verbose?: boolean;
  /** Only print the summary box. */
  summaryOnly?: boolean;
}

const CATEGORY_ORDER: Category[] = ['secrets', 'supabase', 'firebase', 'security', 'nextjs', 'dependencies', 'build', 'config', 'code-quality'];

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}

function badge(c: Colors, sev: Severity): string {
  const label = ` ${sev.toUpperCase()} `.padEnd(10);
  switch (sev) {
    case 'critical':
      return c.bold(c.bgRed(c.white(label)));
    case 'high':
      return c.bold(c.bgYellow(c.black(label)));
    case 'medium':
      return c.bold(c.bgBlue(c.white(label)));
    case 'low':
      return c.bgBlack(c.white(label));
    default:
      return c.dim(label);
  }
}

function sevColor(c: Colors, sev: Severity): (s: string) => string {
  return sev === 'critical' ? c.red : sev === 'high' ? c.yellow : sev === 'medium' ? c.blue : sev === 'low' ? c.white : c.dim;
}

function scoreColor(c: Colors, score: number, critical: number): (s: string) => string {
  if (critical > 0 || score < 50) return c.red;
  if (score < 80) return c.yellow;
  return c.green;
}

/* eslint-disable-next-line no-control-regex */
const visibleLength = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '').length;

export function renderSummary(result: AuditResult, c: Colors, width: number): string[] {
  const lines: string[] = [];
  const v = verdict(result);
  const sc = scoreColor(c, result.score, result.counts.critical);
  const inner = Math.min(width, 76) - 4;
  const row = (content: string) => `  ${c.dim('│')} ${content}${' '.repeat(Math.max(0, inner - visibleLength(content)))} ${c.dim('│')}`;
  lines.push(`  ${c.dim(`╭${'─'.repeat(inner + 2)}╮`)}`);
  lines.push(row(`${c.bold('Score')}  ${sc(c.bold(`${result.score}/100`))}   ${c.bold('Grade')} ${sc(c.bold(result.grade))}   ${sc(v.headline)}`));
  const counts = SEVERITIES.map((s) => `${sevColor(c, s)('●')} ${result.counts[s]} ${s}`).join('  ');
  lines.push(row(counts));
  lines.push(`  ${c.dim(`╰${'─'.repeat(inner + 2)}╯`)}`);
  return lines;
}

function renderFinding(f: Finding, c: Colors, width: number, verbose: boolean): string[] {
  const lines: string[] = [];
  const pad = ' '.repeat(13);
  const titleWidth = Math.max(30, width - 13 - f.ruleId.length - 4);
  const titleLines = wrap(f.title, titleWidth);
  lines.push(`  ${badge(c, f.severity)} ${c.bold(titleLines[0] ?? '')}  ${c.dim(f.ruleId)}${f.heuristic ? c.dim(' ~heuristic') : ''}`);
  for (const t of titleLines.slice(1)) lines.push(`${pad}${c.bold(t)}`);
  const loc = location(f);
  if (loc) lines.push(`${pad}${c.cyan(loc)}${f.count && f.count > 1 && f.locations ? c.dim(` (+${f.count - 1} more)`) : ''}`);
  if (f.snippet) lines.push(`${pad}${c.dim('│')} ${c.gray(f.snippet.length > width - 16 ? `${f.snippet.slice(0, width - 17)}…` : f.snippet)}`);
  for (const m of wrap(f.message, width - 13)) lines.push(`${pad}${m}`);
  if (verbose) {
    const why = wrap(f.why, width - 18);
    lines.push(`${pad}${c.dim('Why ')} ${why[0] ?? ''}`);
    for (const w of why.slice(1)) lines.push(`${pad}     ${w}`);
  }
  const fix = wrap(f.fix, width - 18);
  lines.push(`${pad}${c.green('Fix ')} ${fix[0] ?? ''}`);
  for (const w of fix.slice(1)) lines.push(`${pad}     ${w}`);
  return lines;
}

export function renderTerminal(result: AuditResult, opts: TerminalOptions = {}): string {
  const c = pc.createColors(opts.color ?? false);
  const width = Math.max(72, Math.min(opts.width ?? 100, 120));
  const out: string[] = [];
  out.push('');
  out.push(`  ${c.bold(c.magenta('launch-check'))} ${c.dim(`v${result.tool.version} · production-readiness audit`)}`);
  out.push('');
  out.push(`  ${c.dim('Project')}  ${c.bold(result.project.name)}`);
  out.push(`  ${c.dim('Stack  ')}  ${describeStack(result.detection)}`);
  out.push(
    `  ${c.dim('Scanned')}  ${result.filesScanned} files · ${result.rulesRun.length} checks · ${(result.durationMs / 1000).toFixed(1)}s` +
      (result.suppressed ? c.dim(` · ${result.suppressed} suppressed`) : ''),
  );
  out.push('');
  out.push(...renderSummary(result, c, width));

  if (!opts.summaryOnly) {
    for (const cat of CATEGORY_ORDER) {
      const group = result.findings.filter((f) => f.category === cat);
      if (group.length === 0) continue;
      out.push('');
      out.push(`  ${c.bold(c.underline(CATEGORY_LABELS[cat].toUpperCase()))} ${c.dim(`(${group.length})`)}`);
      for (const f of group) {
        out.push('');
        out.push(...renderFinding(f, c, width, opts.verbose ?? false));
      }
    }
    if (result.findings.length === 0) {
      out.push('');
      out.push(`  ${c.green('✔')} No issues found by ${result.rulesRun.length} checks.`);
    }
  }
  if (result.errors.length > 0) {
    out.push('');
    for (const e of result.errors) out.push(`  ${c.red('✖')} rule ${e.ruleId} crashed: ${e.message}`);
  }
  out.push('');
  out.push(c.dim(`  ~heuristic = pattern-based check, verify manually. Add --md report.md for a shareable report${opts.verbose ? '' : ', --verbose for "why it matters"'}.`));
  out.push('');
  return out.join('\n');
}
