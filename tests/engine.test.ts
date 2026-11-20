import { describe, expect, it } from 'vitest';
import { audit, exceedsThreshold } from '../src/audit.js';
import { loadConfig } from '../src/config.js';
import { computeScore, gradeFor } from '../src/score.js';
import type { Finding } from '../src/types.js';
import { project, scan } from './helpers.js';

const evalProject = (extra: Record<string, string | object> = {}) => ({
  'package.json': { name: 'demo', dependencies: { express: '5.0.0' } },
  'src/a.ts': 'eval(input);\n',
  ...extra,
});

describe('file walking', () => {
  it('respects .gitignore (root and nested), skips node_modules and build output', async () => {
    const result = await scan(
      {
        ...evalProject(),
        '.gitignore': 'generated/\n',
        'generated/b.ts': 'eval(x);',
        'packages/web/.gitignore': 'tmp.ts\n',
        'packages/web/tmp.ts': 'eval(x);',
        'node_modules/lib/index.js': 'eval(x);',
        '.next/server/page.js': 'eval(x);',
        'dist/out.js': 'eval(x);',
      },
      'security/eval',
    );
    expect(result.findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('honours --ignore globs', async () => {
    const result = await scan(evalProject({ 'legacy/old.ts': 'eval(x);' }), 'security/eval', { ignore: ['legacy/**'] });
    expect(result.findings.map((f) => f.file)).toEqual(['src/a.ts']);
  });
});

describe('config', () => {
  it('turns rules off, overrides severity and adds ignores', async () => {
    const root = project(
      evalProject({
        'legacy/old.ts': 'eval(x);',
        'launch-check.config.json': JSON.stringify({ ignore: ['legacy/'], rules: { 'security/eval': 'low', 'config/env-example': 'off' }, failOn: 'high' }),
      }),
    );
    const result = await audit(root, { git: false, audit: false });
    const evals = result.findings.filter((f) => f.ruleId === 'security/eval');
    expect(evals.map((f) => [f.file, f.severity])).toEqual([['src/a.ts', 'low']]);
    expect(result.rulesRun).not.toContain('config/env-example');
    expect(result.config.failOn).toBe('high');
  });

  it('reads the launchCheck key from package.json', () => {
    const root = project({ 'package.json': { name: 'x', launchCheck: { failOn: 'medium' } } });
    expect(loadConfig(root)).toMatchObject({ failOn: 'medium', configFile: 'package.json#launchCheck' });
  });

  it('rejects invalid config with a helpful error', () => {
    const root = project({ 'launch-check.config.json': '{ "rules": { "security/eval": "severe" } }' });
    expect(() => loadConfig(root)).toThrow(/must be "off" or one of critical/);
    const root2 = project({ 'launch-check.config.json': '{ "ignores": [] }' });
    expect(() => loadConfig(root2)).toThrow(/unknown key "ignores"/);
  });
});

describe('inline suppressions', () => {
  it('supports ignore-next-line, same-line and file-level comments', async () => {
    const result = await scan(
      {
        'package.json': { name: 'x' },
        'src/a.ts': '// launch-check-ignore-next-line security/eval\neval(a);\neval(b); // launch-check-ignore\neval(c);\n',
        'src/b.ts': '/* launch-check-ignore-file security/eval */\neval(d);\n',
        'src/c.ts': '// launch-check-ignore-next-line code-quality/debugger\neval(e);\n',
      },
      'security/eval',
    );
    expect(result.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['src/a.ts:4', 'src/c.ts:2']);
    expect(result.suppressed).toBe(3);
  });
});

describe('scoring and thresholds', () => {
  const f = (severity: Finding['severity'], ruleId = `r/${severity}`): Finding =>
    ({ ruleId, severity, category: 'security', title: '', message: '', why: '', fix: '', heuristic: false }) as Finding;

  it('starts at 100 and degrades with severity', () => {
    expect(computeScore([])).toBe(100);
    expect(computeScore([f('info')])).toBe(100);
    expect(computeScore([f('low')])).toBeGreaterThan(computeScore([f('medium')]));
    expect(computeScore([f('medium')])).toBeGreaterThan(computeScore([f('high')]));
    expect(computeScore([f('high')])).toBeGreaterThan(computeScore([f('critical')]));
  });

  it('caps repeated findings of one rule', () => {
    const many = Array.from({ length: 50 }, () => f('low', 'same/rule'));
    expect(computeScore(many)).toBe(computeScore([f('low', 'same/rule'), f('low', 'same/rule'), f('low', 'same/rule'), f('low', 'same/rule')]));
  });

  it('never grades a project with a critical finding above D', () => {
    expect(gradeFor(95, [f('critical')])).toBe('D');
    expect(gradeFor(95, [f('high')])).toBe('A');
  });

  it('decides the exit threshold', async () => {
    const result = await scan(evalProject(), 'security/eval');
    expect(exceedsThreshold(result, 'critical')).toBe(false);
    expect(exceedsThreshold(result, 'high')).toBe(true);
    expect(exceedsThreshold(result, 'none')).toBe(false);
  });
});

describe('project detection', () => {
  it('detects Next.js routers, integrations and the package manager', async () => {
    const result = await scan({
      'package.json': { dependencies: { next: '15.5.0', react: '19.1.0', '@supabase/ssr': '0.6.0', stripe: '18.0.0', '@prisma/client': '6.0.0' } },
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  next@15.5.4:\n    resolution: {}\n",
      'src/app/page.tsx': 'x',
      'src/pages/legacy.tsx': 'x',
    });
    expect(result.detection).toMatchObject({
      frameworks: ['nextjs-app', 'nextjs-pages'],
      integrations: ['supabase', 'prisma', 'stripe'],
      packageManager: 'pnpm',
      appDir: 'src/app',
      pagesDir: 'src/pages',
      resolved: { next: '15.5.4' },
    });
  });

  it('detects Vite + React and Express', async () => {
    const vite = await scan({ 'package.json': { dependencies: { react: '19.0.0' }, devDependencies: { vite: '6.0.0', '@vitejs/plugin-react': '4.0.0' } } });
    expect(vite.detection.frameworks).toEqual(['vite-react']);
    const api = await scan({ 'package.json': { dependencies: { express: '5.0.0' } } });
    expect(api.detection.frameworks).toEqual(['express']);
  });

  it('fails clearly on a missing path', async () => {
    await expect(audit('/definitely/not/here')).rejects.toThrow('Path not found');
  });
});
