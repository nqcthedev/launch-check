import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { audit, exceedsThreshold } from './audit.js';
import { ConfigError } from './config.js';
import { renderJson } from './reporters/json.js';
import { renderMarkdown } from './reporters/markdown.js';
import { renderTerminal } from './reporters/terminal.js';
import { allRules } from './rules/index.js';
import { CATEGORY_LABELS, SEVERITIES, type Severity } from './types.js';
import { VERSION } from './version.js';

const HELP = `
launch-check v${VERSION}
Production-readiness audit for AI-built Next.js, Vite and Node apps.

Usage
  npx launch-check [path] [options]

Output
  --json                 Print the full result as JSON to stdout
  --md <file>            Write a client-ready Markdown report to <file>
  --prepared-by <name>   "Prepared by" line in the Markdown report
  --verbose              Show "why it matters" for each finding
  --summary              Only print the score summary
  --no-color             Disable colors (also honours NO_COLOR)

Checks
  --build                Also run the project's build script and report errors
  --no-audit             Skip \`npm audit\` / \`pnpm audit\` (needs network)
  --only <ids>           Comma-separated rule ids or categories (e.g. secrets,supabase)
  --ignore <glob>        Extra path to ignore (repeatable; .gitignore is always honoured)
  --config <file>        Config file (default: launch-check.config.json)
  --no-git               Do not ask git which files are tracked

CI
  --fail-on <severity>   Exit 1 if any finding is at or above: critical (default),
                         high, medium, low, info, or none

Other
  --list-rules           List all checks
  -v, --version          Print version
  -h, --help             Show this help

Exit codes: 0 = passed, 1 = findings at/above --fail-on, 2 = usage or runtime error.
`;

function listRules(color: boolean): string {
  const c = pc.createColors(color);
  const lines = ['', `  ${c.bold('launch-check rules')} ${c.dim(`(${allRules.length})`)}`, ''];
  for (const r of allRules) {
    lines.push(`  ${c.cyan(r.id.padEnd(40))} ${r.severity.padEnd(8)} ${r.title}${r.heuristic ? c.dim(' (heuristic)') : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        md: { type: 'string' },
        'prepared-by': { type: 'string' },
        verbose: { type: 'boolean' },
        summary: { type: 'boolean' },
        color: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        build: { type: 'boolean' },
        audit: { type: 'boolean' },
        'no-audit': { type: 'boolean' },
        git: { type: 'boolean' },
        'no-git': { type: 'boolean' },
        only: { type: 'string' },
        ignore: { type: 'string', multiple: true },
        config: { type: 'string' },
        'fail-on': { type: 'string' },
        'list-rules': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`launch-check: ${(err as Error).message}\nRun with --help for usage.\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const color =
    values['no-color'] || process.env.NO_COLOR ? false : values.color ? true : Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR);

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values['list-rules']) {
    process.stdout.write(listRules(color));
    return 0;
  }
  if (positionals.length > 1) {
    process.stderr.write(`launch-check: expected at most one path, got ${positionals.length}\n`);
    return 2;
  }
  const failOnRaw = values['fail-on'];
  if (failOnRaw && failOnRaw !== 'none' && !SEVERITIES.includes(failOnRaw as Severity)) {
    process.stderr.write(`launch-check: --fail-on must be one of ${SEVERITIES.join(', ')}, none\n`);
    return 2;
  }
  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  if (only) {
    const known = new Set([...allRules.map((r) => r.id), ...Object.keys(CATEGORY_LABELS), ...allRules.map((r) => r.id.split('/')[0]!)]);
    const unknown = only.filter((o) => !known.has(o));
    if (unknown.length > 0) {
      process.stderr.write(`launch-check: unknown rule or category in --only: ${unknown.join(', ')} (see --list-rules)\n`);
      return 2;
    }
  }

  const target = positionals[0] ?? '.';
  try {
    const result = await audit(target, {
      build: values.build ?? false,
      audit: !values['no-audit'],
      git: !values['no-git'],
      ...(values.config ? { configPath: values.config } : {}),
      ...(values.ignore ? { ignore: values.ignore } : {}),
      ...(only ? { only } : {}),
    });

    if (values.json) {
      process.stdout.write(renderJson(result));
    } else {
      process.stdout.write(
        renderTerminal(result, {
          color,
          width: process.stdout.columns ?? 100,
          verbose: values.verbose ?? false,
          summaryOnly: values.summary ?? false,
        }),
      );
    }
    if (values.md) {
      writeFileSync(values.md, renderMarkdown(result, values['prepared-by'] ? { preparedBy: values['prepared-by'] } : {}));
      if (!values.json) process.stdout.write(`  Markdown report written to ${values.md}\n\n`);
    }
    const failOn = (failOnRaw as Severity | 'none' | undefined) ?? result.config.failOn;
    return exceedsThreshold(result, failOn) ? 1 : 0;
  } catch (err) {
    const msg = err instanceof ConfigError ? `config error: ${err.message}` : (err as Error).message;
    process.stderr.write(`launch-check: ${msg}\n`);
    return 2;
  }
}
