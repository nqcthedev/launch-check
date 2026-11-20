#!/usr/bin/env node
// Regenerates the case study: runs the built CLI on both fixtures and writes the real
// output to docs/case-study/, then refreshes the README section between the markers.
// Usage: npm run case-study   (runs `npm run build` first)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'case-study');
mkdirSync(out, { recursive: true });
const cli = join(root, 'dist', 'cli.js');

function run(args, color) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '100', ...(color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' }) },
  });
  if (res.status === 2) throw new Error(res.stderr);
  return { stdout: res.stdout, code: res.status };
}

const results = {};
for (const name of ['vibe-app-broken', 'vibe-app-fixed']) {
  const target = `fixtures/${name}`;
  const json = JSON.parse(run([target, '--json', '--fail-on', 'none']).stdout);
  results[name] = json;
  writeFileSync(join(out, `${name}.ansi`), run([target, '--color', '--fail-on', 'none'], true).stdout);
  const plain = run([target, '--no-color']);
  writeFileSync(join(out, `${name}.txt`), plain.stdout);
  run([target, '--md', join('docs', 'case-study', `${name}-report.md`), '--fail-on', 'none', '--no-color']);
  results[name].exitCodeFailOnHigh = run([target, '--fail-on', 'high', '--no-color']).code;
}

const before = results['vibe-app-broken'];
const after = results['vibe-app-fixed'];
const sev = ['critical', 'high', 'medium', 'low', 'info'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const loc = (f) => (f.file ? `\`${f.line ? `${f.file}:${f.line}` : f.file}\`` : '');
const esc = (s) => s.replace(/\|/g, '\\|');

const lines = [];
lines.push('| | Before (`fixtures/vibe-app-broken`) | After (`fixtures/vibe-app-fixed`) |');
lines.push('|---|---|---|');
lines.push(`| Score | **${before.score}/100 (${before.grade})** | **${after.score}/100 (${after.grade})** |`);
for (const s of sev) lines.push(`| ${cap(s)} | ${before.counts[s]} | ${after.counts[s]} |`);
lines.push(`| \`--fail-on high\` exit code | ${before.exitCodeFailOnHigh} (CI fails) | ${after.exitCodeFailOnHigh} (CI passes) |`);
lines.push(`| Checks run | ${before.rulesRun.length} | ${after.rulesRun.length} |`);
lines.push('');
lines.push('<details><summary><b>Every finding in the "before" report</b> (all resolved in the fixed app)</summary>');
lines.push('');
lines.push('| Severity | Check | Finding | Location |');
lines.push('|---|---|---|---|');
for (const f of before.findings) {
  lines.push(`| ${cap(f.severity)} | \`${f.ruleId}\` | ${esc(f.title)}${f.heuristic ? ' _(heuristic)_' : ''} | ${loc(f)} |`);
}
lines.push('');
lines.push('</details>');
if (after.findings.length > 0) {
  lines.push('');
  lines.push('Remaining after the fix:');
  lines.push('');
  for (const f of after.findings) lines.push(`- ${cap(f.severity)}: ${f.title} (${loc(f)})`);
}
const block = lines.join('\n');
writeFileSync(join(out, 'summary.md'), `${block}\n`);

const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const start = '<!-- case-study:start -->';
const end = '<!-- case-study:end -->';
if (readme.includes(start) && readme.includes(end)) {
  const next = `${readme.slice(0, readme.indexOf(start) + start.length)}\n${block}\n${readme.slice(readme.indexOf(end))}`;
  writeFileSync(readmePath, next);
  console.log('README case study refreshed.');
}
console.log(`before: ${before.score}/100 ${JSON.stringify(before.counts)}`);
console.log(`after:  ${after.score}/100 ${JSON.stringify(after.counts)}`);
