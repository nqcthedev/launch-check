import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBuildOutput } from '../../src/rules/build.js';
import { findings } from '../helpers.js';

describe('parseBuildOutput', () => {
  it('parses real Next.js 16 type-check output', () => {
    const out = readFileSync(new URL('../data/next16-type-error.txt', import.meta.url), 'utf8');
    expect(parseBuildOutput(out)).toEqual([
      {
        file: 'app/dashboard/page.tsx',
        line: 25,
        column: 9,
        code: 'TS2322',
        message: "Type '{ id: any; title: any; done: any; }[] | 42' is not assignable to type 'Todo[]'.",
      },
    ]);
  });

  it('parses Next.js 14/15 webpack-style errors', () => {
    const out = [
      'Failed to compile.',
      '',
      './app/page.tsx:12:5',
      'Type error: Property \'foo\' does not exist on type \'Bar\'.',
      '',
      './components/Chart.tsx',
      "Module not found: Can't resolve 'recharts'",
    ].join('\n');
    expect(parseBuildOutput(out)).toEqual([
      { file: 'app/page.tsx', line: 12, column: 5, code: 'type-error', message: "Property 'foo' does not exist on type 'Bar'." },
      { file: 'components/Chart.tsx', code: 'module-not-found', message: "Can't resolve 'recharts'" },
    ]);
  });

  it('parses tsc pretty output, vite/rollup and esbuild errors', () => {
    const out = [
      'src/a.ts:3:7 - error TS2304: Cannot find name \'foo\'.',
      '[vite]: Rollup failed to resolve import "lodash" from "/repo/src/App.tsx".',
      '✘ [ERROR] Expected ";" but found "}"',
      '',
      '    src/b.ts:9:2:',
    ].join('\n');
    expect(parseBuildOutput(out, '/repo')).toEqual([
      { file: 'src/a.ts', line: 3, column: 7, code: 'TS2304', message: "Cannot find name 'foo'." },
      { file: 'src/App.tsx', code: 'unresolved-import', message: 'Failed to resolve import "lodash"' },
      { file: 'src/b.ts', line: 9, column: 2, code: 'esbuild', message: 'Expected ";" but found "}"' },
    ]);
  });
});

describe('build/production-build', () => {
  it('does not run unless --build is given', async () => {
    expect(await findings({ 'package.json': { scripts: { build: 'exit 1' } } }, 'build/production-build')).toEqual([]);
  });

  it('skips with an info finding when dependencies are not installed', async () => {
    const out = await findings({ 'package.json': { scripts: { build: 'exit 1' } } }, 'build/production-build', { build: true });
    expect(out.map((f) => f.title)).toEqual(['Build skipped: dependencies not installed']);
  });

  it('runs the build script and reports parsed errors', async () => {
    const script = `node -e "console.log('src/a.ts(1,2): error TS1005: oops'); process.exit(1)"`;
    const out = await findings(
      { 'package.json': { name: 'b', scripts: { build: script } }, 'package-lock.json': '{}', 'node_modules/.keep': '' },
      'build/production-build',
      { build: true },
    );
    expect(out.map((f) => [f.severity, f.file, f.line, f.message])).toEqual([['high', 'src/a.ts', 1, 'oops']]);
  });

  it('reports success as info', async () => {
    const out = await findings(
      { 'package.json': { name: 'b', scripts: { build: 'node -e "process.exit(0)"' } }, 'package-lock.json': '{}', 'node_modules/.keep': '' },
      'build/production-build',
      { build: true },
    );
    expect(out.map((f) => f.severity)).toEqual(['info']);
  });
});
