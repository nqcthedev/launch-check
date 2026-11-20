import type { Finding, Severity } from './types.js';

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 20, high: 8, medium: 3, low: 1, info: 0 };

/**
 * Weighted penalty mapped onto 0-100. Repeats of the same rule count half and are capped,
 * so one noisy rule cannot dominate the score.
 */
export function computeScore(findings: Finding[]): number {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byRule.get(f.ruleId) ?? [];
    list.push(f);
    byRule.set(f.ruleId, list);
  }
  let penalty = 0;
  for (const list of byRule.values()) {
    const weights = list.map((f) => SEVERITY_WEIGHT[f.severity]).sort((a, b) => b - a);
    const first = weights[0] ?? 0;
    const rest = weights.slice(1).reduce((s, w) => s + w / 2, 0);
    penalty += first + Math.min(rest, first * 1.5);
  }
  // Asymptotic: one medium costs ~7 points, one critical ~33; the score never hits 0 or goes negative.
  return Math.round((100 * 40) / (40 + penalty));
}

export function gradeFor(score: number, findings: Finding[]): string {
  const hasCritical = findings.some((f) => f.severity === 'critical');
  let grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  // A single critical issue means "do not launch", whatever the arithmetic says.
  if (hasCritical && (grade === 'A' || grade === 'B' || grade === 'C')) grade = 'D';
  return grade;
}
