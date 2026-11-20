import { describe, expect, it } from 'vitest';
import { parseImports, resolveImport } from '../src/graph.js';
import { lockfileVersions } from '../src/utils/lockfile.js';
import { decodeJwt, isPlaceholder, redact, shannonEntropy } from '../src/utils/secrets.js';
import { LineIndex, hasDirective, maskSource, parseJsonc } from '../src/utils/text.js';
import { compareVersions, isUnpinnedRange, parseVersion } from '../src/utils/version.js';

describe('maskSource', () => {
  it('blanks comments while preserving offsets and newlines', () => {
    const src = 'a // x\n/* y\n z */ b';
    const masked = maskSource(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.split('\n')).toHaveLength(3);
    expect(masked.replace(/\s+/g, '')).toBe('ab');
  });

  it('does not treat // inside strings, templates or regexes as comments', () => {
    const src = `const u = "https://x.dev"; const t = \`//\${a}\`; const r = /\\/\\//g; keep();`;
    expect(maskSource(src)).toBe(src);
  });

  it('optionally masks string, template and regex contents but keeps template expressions', () => {
    const masked = maskSource('f("eval(x)", `a${eval(y)}b`, /eval/)', { comments: true, strings: true });
    expect(masked).not.toContain('eval(x)');
    expect(masked).toContain('eval(y)');
    expect(masked).not.toMatch(/\/eval\//);
  });
});

describe('text helpers', () => {
  it('maps offsets to lines and columns', () => {
    const idx = new LineIndex('ab\ncd\r\nef');
    expect(idx.lineOf(0)).toBe(1);
    expect(idx.lineOf(4)).toBe(2);
    expect(idx.columnOf(4)).toBe(2);
    expect(idx.line(2)).toBe('cd');
    expect(idx.line(3)).toBe('ef');
  });

  it('detects directives only in the prologue', () => {
    expect(hasDirective(`// comment\n'use client';\nimport x from 'y'`, 'use client')).toBe(true);
    expect(hasDirective(`"use strict";\n"use server"`, 'use server')).toBe(true);
    expect(hasDirective(`import x from 'y';\n'use client';`, 'use client')).toBe(false);
  });

  it('parses JSON with comments and trailing commas', () => {
    expect(parseJsonc('{ // c\n "a": [1, 2,], /* d */ "b": "//x", }')).toEqual({ a: [1, 2], b: '//x' });
    expect(parseJsonc('{ nope')).toBeNull();
  });
});

describe('secret helpers', () => {
  it('computes entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });

  it('redacts without revealing the secret', () => {
    const r = redact('sk_' + 'live_abcdefghijklmnopqrstuvwxyz');
    expect(r.startsWith('sk_live_')).toBe(true);
    expect(r).not.toContain('abcdefgh');
  });

  it('recognises placeholders', () => {
    expect(isPlaceholder('your-api-key-here')).toBe(true);
    expect(isPlaceholder('sk_' + 'live_xxxxxxxxxxxxxxxx')).toBe(true);
    expect(isPlaceholder('<SECRET>')).toBe(true);
    expect(isPlaceholder('q8Zr2Lx9Vm4Tn7Wk1Pb6')).toBe(false);
  });

  it('decodes JWT claims without verifying', () => {
    const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"anon"}').toString('base64url')}.sig`;
    expect(decodeJwt(token)?.payload.role).toBe('anon');
    expect(decodeJwt('not.a.jwt')).toBeNull();
  });
});

describe('versions', () => {
  it('parses lower bounds of ranges', () => {
    expect(parseVersion('^14.1.0')).toMatchObject({ major: 14, minor: 1, patch: 0 });
    expect(parseVersion('~15')).toMatchObject({ major: 15, minor: 0, patch: 0 });
    expect(parseVersion('latest')).toBeNull();
  });
  it('compares versions including prereleases', () => {
    expect(compareVersions(parseVersion('14.2.25')!, parseVersion('14.2.3')!)).toBeGreaterThan(0);
    expect(compareVersions(parseVersion('15.0.0-rc.1')!, parseVersion('15.0.0')!)).toBeLessThan(0);
  });
  it('detects unpinned ranges', () => {
    expect(['latest', '*', '>=1.0.0', ''].every(isUnpinnedRange)).toBe(true);
    expect(['^1.0.0', '1.2.3', '>=1 <2', '~2.0.0'].some(isUnpinnedRange)).toBe(false);
  });
});

describe('lockfileVersions', () => {
  it('reads npm, pnpm and yarn lockfiles', () => {
    const npm = JSON.stringify({ packages: { '': {}, 'node_modules/react': { version: '19.1.0' }, 'node_modules/x/node_modules/react': { version: '18.3.1' } } });
    expect(lockfileVersions('package-lock.json', npm, ['react']).get('react')).toEqual(['18.3.1', '19.1.0']);
    const pnpm = "lockfileVersion: '9.0'\npackages:\n\n  react@19.1.0:\n    resolution: {}\n\n  next@15.5.0(react@19.1.0):\n    resolution: {}\n";
    const pnpmVersions = lockfileVersions('pnpm-lock.yaml', pnpm, ['react', 'next']);
    expect(pnpmVersions.get('react')).toEqual(['19.1.0']);
    expect(pnpmVersions.get('next')).toEqual(['15.5.0']);
    const yarn = 'react@^18.2.0:\n  version "18.2.0"\n  resolved "x"\n\n"@types/react@^18":\n  version "18.3.3"\n';
    expect(lockfileVersions('yarn.lock', yarn, ['react']).get('react')).toEqual(['18.2.0']);
  });
});

describe('import graph helpers', () => {
  it('extracts static, dynamic, re-export and require imports, flagging type-only ones', () => {
    const refs = parseImports(
      [`import a from './a';`, `import type { B } from "./b";`, `export { c } from '@/c';`, `const d = await import('./d');`, `const e = require('e');`, `// import f from './f';`, `import './side-effect';`].join('\n'),
    );
    expect(refs.map((r) => [r.specifier, r.typeOnly])).toEqual([
      ['./a', false],
      ['./b', true],
      ['@/c', false],
      ['./d', false],
      ['e', false],
      ['./side-effect', false],
    ]);
  });

  it('resolves relative, alias and index imports', () => {
    const files = new Set(['src/lib/a.ts', 'src/lib/b/index.tsx', 'src/c.js']);
    const isFile = (p: string) => files.has(p);
    const aliases = { baseUrl: null, paths: [{ prefix: '@/', suffix: '', targets: ['src/*'] }] };
    expect(resolveImport('src/x.ts', './lib/a', aliases, isFile)).toBe('src/lib/a.ts');
    expect(resolveImport('src/x.ts', '@/lib/b', aliases, isFile)).toBe('src/lib/b/index.tsx');
    expect(resolveImport('src/lib/a.ts', '../c.js', aliases, isFile)).toBe('src/c.js');
    expect(resolveImport('src/x.ts', 'react', aliases, isFile)).toBeNull();
  });
});
