import type { AuditResult, Finding, Severity } from '../types.js';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const SEVERITY_MEANING: Record<Severity, string> = {
  critical: 'Exploitable now: exposes data, credentials or money. Fix before anything else.',
  high: 'Serious risk or broken behaviour. Fix before launch.',
  medium: 'Weakens security or reliability. Fix soon after launch.',
  low: 'Hardening, SEO and maintainability.',
  info: 'For awareness; no score impact.',
};

export function verdict(result: AuditResult): { headline: string; detail: string } {
  const c = result.counts;
  if (c.critical > 0) {
    return {
      headline: 'Not ready for production',
      detail: `${c.critical} critical issue${c.critical === 1 ? '' : 's'} can be exploited by anyone on the internet today and must be fixed before launch.`,
    };
  }
  if (c.high > 0) {
    return {
      headline: 'Needs work before launch',
      detail: `No critical issues, but ${c.high} high-severity issue${c.high === 1 ? '' : 's'} should be fixed before real users arrive.`,
    };
  }
  if (c.medium > 0) {
    return { headline: 'Ready to launch, with follow-ups', detail: `No critical or high issues. ${c.medium} medium issue${c.medium === 1 ? '' : 's'} to schedule.` };
  }
  return { headline: 'Ready to launch', detail: 'No critical, high or medium issues were found by the automated checks.' };
}

export function location(f: Finding): string {
  if (!f.file) return '';
  return f.line ? `${f.file}:${f.line}` : f.file;
}

export function stackLabel(result: AuditResult, describe: (d: AuditResult['detection']) => string): string {
  return describe(result.detection);
}

export function codeLang(file: string | undefined): string {
  if (!file) return '';
  const ext = file.split('.').pop() ?? '';
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    sql: 'sql',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    html: 'html',
    rules: 'js',
  };
  if (/(^|\/)\.env/.test(file)) return 'dotenv';
  return map[ext] ?? '';
}
