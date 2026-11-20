#!/usr/bin/env node
// Renders the real, colored CLI output (docs/case-study/*.ansi, written by `npm run case-study`)
// into a terminal-window HTML page and screenshots it with Playwright at deviceScaleFactor 2.
// Also renders the client-facing Markdown report. Output: docs/images/*.png
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const caseDir = join(root, 'docs', 'case-study');
const imgDir = join(root, 'docs', 'images');
mkdirSync(imgDir, { recursive: true });

const PALETTE = {
  30: '#1e2030', 31: '#ff6b6b', 32: '#7ee787', 33: '#f9c74f', 34: '#6cb6ff', 35: '#d2a8ff', 36: '#56d4dd', 37: '#e6edf3',
  90: '#8b949e', 91: '#ff8585', 92: '#9bf0a8', 93: '#ffd86b', 94: '#8cc8ff', 95: '#e2c2ff', 96: '#7ee0e8', 97: '#ffffff',
};
const BG = { 40: '#30363d', 41: '#d73a49', 42: '#2ea043', 43: '#d29922', 44: '#1f6feb', 45: '#8957e5', 46: '#1b7c83', 47: '#e6edf3' };

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Minimal SGR -> HTML converter (enough for picocolors output). */
function ansiToHtml(text) {
  const state = { fg: null, bg: null, bold: false, dim: false, underline: false };
  let html = '';
  let open = false;
  const style = () => {
    const css = [];
    if (state.fg) css.push(`color:${state.fg}`);
    if (state.bg) css.push(`background:${state.bg}`);
    if (state.bold) css.push('font-weight:700');
    if (state.dim) css.push('opacity:.62');
    if (state.underline) css.push('text-decoration:underline;text-underline-offset:3px');
    return css.join(';');
  };
  for (const part of text.split(/(\u001b\[[0-9;]*m)/)) {
    const m = /^\u001b\[([0-9;]*)m$/.exec(part);
    if (!m) {
      html += escapeHtml(part);
      continue;
    }
    for (const codeStr of (m[1] || '0').split(';')) {
      const code = Number(codeStr);
      if (code === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, underline: false });
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 22) state.bold = state.dim = false;
      else if (code === 4) state.underline = true;
      else if (code === 24) state.underline = false;
      else if (code === 39) state.fg = null;
      else if (code === 49) state.bg = null;
      else if (PALETTE[code]) state.fg = PALETTE[code];
      else if (BG[code]) state.bg = BG[code];
    }
    if (open) html += '</span>';
    const s = style();
    html += s ? `<span style="${s}">` : '<span>';
    open = true;
  }
  if (open) html += '</span>';
  return html;
}

function terminalPage(title, ansi) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; padding:40px; background:linear-gradient(135deg,#1a1f35 0%,#0d1117 60%); font-family: ui-sans-serif, system-ui; }
  .win { display:inline-block; border-radius:12px; overflow:hidden; background:#0d1117; box-shadow:0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); }
  .bar { height:38px; display:flex; align-items:center; gap:8px; padding:0 16px; background:#161b22; border-bottom:1px solid #21262d; }
  .dot { width:12px; height:12px; border-radius:50%; } .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title { flex:1; text-align:center; color:#8b949e; font-size:13px; margin-right:52px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin:0; padding:18px 22px 22px; color:#e6edf3; font: 13.5px/1.5 "DejaVu Sans Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space:pre; }
  .fade { color:#8b949e; font-style:italic; }
</style></head><body><div class="win"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><div class="title">${escapeHtml(title)}</div></div><pre>${ansi}</pre></div></body></html>`;
}

/** Keep the first `maxLines`, cut at a blank line so no finding is chopped in half. */
function truncate(ansi, maxLines) {
  const lines = ansi.split('\n');
  if (lines.length <= maxLines) return { text: ansi, cut: 0 };
  let end = maxLines;
  const plain = (i) => lines[i].replace(/\u001b\[[0-9;]*m/g, '');
  while (end > 0 && plain(end - 1).trim() !== '') end--;
  // Do not end on a dangling category heading.
  while (end > 1 && (plain(end - 1).trim() === '' || /^\s{2}[A-Z][A-Z &.-]+\(\d+\)$/.test(plain(end - 1)))) end--;
  const remaining = lines.slice(end).filter((l) => /^\s+(CRITICAL|HIGH|MEDIUM|LOW|INFO)\s/.test(l.replace(/\u001b\[[0-9;]*m/g, ''))).length;
  return { text: lines.slice(0, end).join('\n'), cut: remaining };
}

const reportCss = `
  body { margin:0; padding:40px; background:#eef1f5; font-family: -apple-system, "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
  .doc { width: 860px; background:#fff; border-radius:10px; box-shadow:0 10px 40px rgba(15,23,42,.12); padding:44px 56px; color:#1f2328; font-size:15px; line-height:1.6; }
  h1 { font-size:28px; margin:0 0 18px; padding-bottom:10px; border-bottom:1px solid #d8dee4; }
  h2 { font-size:21px; margin:30px 0 12px; padding-bottom:6px; border-bottom:1px solid #d8dee4; }
  h3 { font-size:17px; margin:24px 0 8px; } h4 { font-size:15.5px; margin:22px 0 6px; }
  table { border-collapse:collapse; margin:10px 0 16px; } td, th { border:1px solid #d0d7de; padding:6px 12px; text-align:left; } th { background:#f6f8fa; }
  code { background:rgba(175,184,193,.2); padding:.15em .4em; border-radius:6px; font-size:85%; font-family: ui-monospace, "DejaVu Sans Mono", monospace; }
  pre { background:#f6f8fa; padding:12px 16px; border-radius:6px; overflow:hidden; } pre code { background:none; padding:0; }
  details { display:none; }`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });

  const shots = [
    { name: 'vibe-app-broken', file: 'terminal-broken.png', maxLines: 96 },
    { name: 'vibe-app-fixed', file: 'terminal-fixed.png', maxLines: 200 },
  ];
  for (const s of shots) {
    const ansi = readFileSync(join(caseDir, `${s.name}.ansi`), 'utf8');
    const { text, cut } = truncate(ansi, s.maxLines);
    let html = ansiToHtml(text);
    if (cut > 0) html += `\n\n  <span class="fade">… ${cut} more findings (full output: docs/case-study/${s.name}.txt)</span>\n`;
    const htmlPath = join(caseDir, `${s.name}.html`);
    writeFileSync(htmlPath, terminalPage(`$ npx launch-check fixtures/${s.name}`, html));
    await page.goto(`file://${htmlPath}`);
    await page.locator('.win').screenshot({ path: join(imgDir, s.file) });
    console.log(`docs/images/${s.file}`);
  }

  const md = readFileSync(join(caseDir, 'vibe-app-broken-report.md'), 'utf8');
  const reportHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${reportCss}</style></head><body><div class="doc">${marked.parse(md)}</div></body></html>`;
  const reportPath = join(caseDir, 'vibe-app-broken-report.html');
  writeFileSync(reportPath, reportHtml);
  await page.goto(`file://${reportPath}`);
  await page.setViewportSize({ width: 1060, height: 1600 });
  const box = await page.locator('.doc').boundingBox();
  await page.screenshot({
    path: join(imgDir, 'report-broken.png'),
    clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: Math.min(box.height + 48, 1650) },
  });
  console.log('docs/images/report-broken.png');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
