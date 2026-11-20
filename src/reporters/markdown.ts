import { describeStack } from '../detect.js';
import { allRules } from '../rules/index.js';
import { CATEGORY_LABELS, SEVERITIES, type AuditResult, type Finding } from '../types.js';
import { SEVERITY_LABEL, SEVERITY_MEANING, codeLang, location, verdict } from './common.js';

export interface MarkdownOptions {
  /** Name shown as "Prepared by" in the report header. */
  preparedBy?: string;
  /** Include the appendix listing every check that ran. Default true. */
  appendix?: boolean;
}

const esc = (s: string) => s.replace(/\|/g, '\\|');

/** Escape HTML outside of `code spans` (inside them Markdown already renders text literally). */
function inline(s: string): string {
  return s
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/</g, '&lt;')))
    .join('');
}

function findingBlock(f: Finding, n: number): string {
  const parts: string[] = [];
  parts.push(`#### ${n}. ${inline(f.title)}`);
  const meta = [`**Severity:** ${SEVERITY_LABEL[f.severity]}`, `**Category:** ${CATEGORY_LABELS[f.category]}`, `**Check:** \`${f.ruleId}\``];
  if (f.heuristic) meta.push('**Heuristic:** yes, verify manually');
  parts.push(meta.join(' · '));
  const loc = location(f);
  if (loc) parts.push(`**Location:** \`${loc}\`${f.count && f.count > 1 ? ` and ${f.count - 1} more` : ''}`);
  parts.push(inline(f.message));
  if (f.snippet) parts.push(`\`\`\`${codeLang(f.file)}\n${f.snippet}\n\`\`\``);
  if (f.locations && f.locations.length > 1) {
    parts.push(
      `<details><summary>All locations (${f.count ?? f.locations.length})</summary>\n\n${f.locations
        .map((l) => `- \`${l.line ? `${l.file}:${l.line}` : l.file}\``)
        .join('\n')}${f.count && f.count > f.locations.length ? `\n- ... and ${f.count - f.locations.length} more` : ''}\n\n</details>`,
    );
  }
  parts.push(`**Why it matters:** ${inline(f.why)}`);
  parts.push(`**How to fix:** ${inline(f.fix)}`);
  if (f.docs) parts.push(`**Reference:** ${f.docs}`);
  return parts.join('\n\n');
}

export function renderMarkdown(result: AuditResult, opts: MarkdownOptions = {}): string {
  const v = verdict(result);
  const date = result.generatedAt.slice(0, 10);
  const out: string[] = [];
  out.push(`# Production Readiness Report: ${result.project.name}`);
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| **Date** | ${date} |`);
  out.push(`| **Stack** | ${esc(describeStack(result.detection))} |`);
  out.push(`| **Score** | **${result.score}/100 (grade ${result.grade})** |`);
  out.push(`| **Verdict** | ${v.headline} |`);
  if (opts.preparedBy) out.push(`| **Prepared by** | ${esc(opts.preparedBy)} |`);
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`**${v.headline}.** ${v.detail}`);
  out.push('');
  out.push('| Severity | Findings | What it means |');
  out.push('|---|---:|---|');
  for (const s of SEVERITIES) out.push(`| ${SEVERITY_LABEL[s]} | ${result.counts[s]} | ${SEVERITY_MEANING[s]} |`);
  out.push('');

  const priorities = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').slice(0, 7);
  if (priorities.length > 0) {
    out.push('## Top priorities');
    out.push('');
    priorities.forEach((f, i) => {
      const loc = location(f);
      out.push(`${i + 1}. **${inline(f.title)}** (${SEVERITY_LABEL[f.severity]})${loc ? ` in \`${loc}\`` : ''}`);
    });
    out.push('');
  }

  out.push('## Findings');
  out.push('');
  if (result.findings.length === 0) {
    out.push('No issues were found by the automated checks.');
    out.push('');
  }
  let n = 0;
  for (const s of SEVERITIES) {
    const group = result.findings.filter((f) => f.severity === s);
    if (group.length === 0) continue;
    out.push(`### ${SEVERITY_LABEL[s]} (${group.length})`);
    out.push('');
    for (const f of group) {
      n++;
      out.push(findingBlock(f, n));
      out.push('');
    }
  }

  out.push('## Scope and method');
  out.push('');
  out.push(
    `- **Automated static analysis** of ${result.filesScanned} source and configuration files (dependencies, build output and gitignored files excluded), ` +
      `using ${result.rulesRun.length} checks that apply to this stack.`,
  );
  out.push(
    '- Checks marked **heuristic** infer intent from code patterns (for example "this handler has no auth check") and can produce false positives; confirm them before acting.',
  );
  out.push('- Secrets are redacted in this report. Any key listed here should be treated as compromised and rotated.');
  out.push('- This is not a penetration test: business-logic flaws, infrastructure configuration and runtime behaviour are out of scope.');
  if (!result.rulesRun.includes('dependencies/vulnerable-packages')) {
    out.push('- Dependency vulnerability scanning (`npm audit`) was not run for this report.');
  }
  if (result.suppressed > 0) out.push(`- ${result.suppressed} finding(s) were suppressed by inline \`launch-check-ignore\` comments.`);
  out.push('');

  if (opts.appendix !== false) {
    out.push('<details><summary>Appendix: checks performed</summary>');
    out.push('');
    out.push('| Check | Category | Result |');
    out.push('|---|---|---|');
    for (const id of result.rulesRun) {
      const rule = allRules.find((r) => r.id === id);
      const hits = result.findings.filter((f) => f.ruleId === id).length;
      out.push(`| \`${id}\` ${rule ? esc(rule.title) : ''} | ${rule ? CATEGORY_LABELS[rule.category] : ''} | ${hits === 0 ? 'Pass' : `${hits} finding${hits === 1 ? '' : 's'}`} |`);
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push(`_Generated by [launch-check](https://www.npmjs.com/package/launch-check) v${result.tool.version} on ${date}._`);
  out.push('');
  return out.join('\n');
}
