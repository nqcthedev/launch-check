import { describe, expect, it } from 'vitest';
import { findings, nextPkg } from '../helpers.js';

const pkg = { 'package.json': nextPkg() };

describe('config/typescript-strict', () => {
  it('flags strict: false and missing strict', async () => {
    expect(await findings({ ...pkg, 'tsconfig.json': '{ "compilerOptions": { "strict": false } }' }, 'config/typescript-strict')).toHaveLength(1);
    expect(await findings({ ...pkg, 'tsconfig.json': '{ "compilerOptions": {} }' }, 'config/typescript-strict')).toHaveLength(1);
  });

  it('flags strict with noImplicitAny turned back off', async () => {
    const out = await findings({ ...pkg, 'tsconfig.json': '{ "compilerOptions": { "strict": true, "noImplicitAny": false } }' }, 'config/typescript-strict');
    expect(out[0]!.title).toContain('noImplicitAny');
  });

  it('follows relative extends and accepts JSONC', async () => {
    const out = await findings(
      {
        ...pkg,
        'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }',
        'tsconfig.json': '{\n  // comments are fine\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": { "jsx": "preserve", },\n}',
      },
      'config/typescript-strict',
    );
    expect(out).toEqual([]);
  });
});

describe('code-quality/any-density', () => {
  it('reports dense any usage with the worst files', async () => {
    const anyFile = Array.from({ length: 12 }, (_, i) => `export const v${i}: any = (x as any);`).join('\n');
    const out = await findings({ ...pkg, 'tsconfig.json': '{}', 'lib/a.ts': anyFile }, 'code-quality/any-density');
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(24);
    expect(out[0]!.severity).toBe('medium');
  });

  it('ignores any in comments, strings and sparse usage', async () => {
    const clean = ['// this can be any value', 'const s = "any: any";', ...Array.from({ length: 400 }, (_, i) => `export const x${i} = ${i};`), 'let y: any;'].join('\n');
    expect(await findings({ ...pkg, 'tsconfig.json': '{}', 'lib/a.ts': clean }, 'code-quality/any-density')).toEqual([]);
  });
});

describe('code-quality/console-log', () => {
  it('aggregates console.log calls and counts browser ones', async () => {
    const out = await findings(
      {
        ...pkg,
        'app/page.tsx': `'use client';\nconsole.log('a');\nconsole.debug('b');\nexport default function P() { return null }`,
        'lib/server.ts': `console.log('c'); console.error('kept');`,
      },
      'code-quality/console-log',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ count: 3, severity: 'low' });
    expect(out[0]!.message).toContain('2 in browser code');
  });

  it('ignores console.error/warn, comments and tests', async () => {
    const out = await findings(
      { ...pkg, 'lib/a.ts': `// console.log('x')\nconsole.error('e'); console.warn('w');`, 'lib/a.test.ts': `console.log('t')` },
      'code-quality/console-log',
    );
    expect(out).toEqual([]);
  });
});

describe('code-quality/debugger', () => {
  it('flags debugger statements but not identifiers or strings', async () => {
    const out = await findings({ ...pkg, 'lib/a.ts': `function f() {\n  debugger;\n}\nconst debuggerEnabled = 'debugger';` }, 'code-quality/debugger');
    expect(out.map((f) => f.line)).toEqual([2]);
  });
});

describe('code-quality/todo-comments', () => {
  it('counts markers in comments and highlights security-related ones', async () => {
    const out = await findings(
      { ...pkg, 'lib/a.ts': `// TODO: refactor\nconst s = "TODO in a string";\n/* FIXME: add auth check */\nexport {}` },
      'code-quality/todo-comments',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ count: 2, severity: 'low', line: 3 });
  });

  it('is info-only without security keywords', async () => {
    const out = await findings({ ...pkg, 'lib/a.ts': `// TODO: rename` }, 'code-quality/todo-comments');
    expect(out.map((f) => f.severity)).toEqual(['info']);
  });
});

describe('security/eval', () => {
  it('flags eval, new Function and string timers', async () => {
    const out = await findings(
      { ...pkg, 'lib/a.ts': `eval(x);\nconst f = new Function('a', 'return a');\nsetTimeout("run()", 10);` },
      'security/eval',
    );
    expect(out.map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it('ignores method calls, comments and strings', async () => {
    const out = await findings(
      { ...pkg, 'lib/a.ts': `redis.eval(script);\npage.evaluate(() => 1);\n// eval(x)\nconst s = "eval(x)";\nsetTimeout(() => run(), 10);` },
      'security/eval',
    );
    expect(out).toEqual([]);
  });
});

describe('security/cors-wildcard-credentials', () => {
  it('flags wildcard or reflected origins combined with credentials', async () => {
    const out = await findings(
      {
        ...pkg,
        'app/api/a/route.ts': `const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': 'true' };`,
        'server.ts': `app.use(cors({ origin: true, credentials: true }));`,
      },
      'security/cors-wildcard-credentials',
    );
    expect(out.map((f) => f.file).sort()).toEqual(['app/api/a/route.ts', 'server.ts']);
  });

  it('allows wildcard without credentials and explicit origins with credentials', async () => {
    const out = await findings(
      {
        ...pkg,
        'app/api/a/route.ts': `const h = { 'Access-Control-Allow-Origin': '*' };`,
        'server.ts': `app.use(cors({ origin: ['https://app.example.com'], credentials: true }));`,
      },
      'security/cors-wildcard-credentials',
    );
    expect(out).toEqual([]);
  });
});

describe('security/sql-injection (heuristic)', () => {
  it('flags interpolated raw SQL', async () => {
    const out = await findings(
      {
        ...pkg,
        'lib/a.ts': [
          'await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);',
          'await pool.query(`SELECT * FROM t WHERE name = \'${name}\'`);',
          "await db.execute(sql.raw(`DELETE FROM t WHERE id = ${id}`));",
        ].join('\n'),
      },
      'security/sql-injection',
    );
    expect(out.map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it('accepts parameterized queries', async () => {
    const out = await findings(
      { ...pkg, 'lib/a.ts': 'await prisma.$queryRaw`SELECT * FROM users WHERE id = ${id}`;\nawait pool.query("SELECT * FROM t WHERE id = $1", [id]);' },
      'security/sql-injection',
    );
    expect(out).toEqual([]);
  });
});

describe('config/env-example', () => {
  const code = { ...pkg, 'lib/a.ts': 'export const a = process.env.STRIPE_SECRET_KEY;\nexport const b = process.env.NODE_ENV;\nconst { RESEND_API_KEY } = process.env;' };

  it('flags a missing .env.example (medium)', async () => {
    const out = await findings(code, 'config/env-example');
    expect(out.map((f) => f.severity)).toEqual(['medium']);
    expect(out[0]!.message).toContain('STRIPE_SECRET_KEY, RESEND_API_KEY');
  });

  it('lists variables missing from .env.example', async () => {
    const out = await findings({ ...code, '.env.example': 'STRIPE_SECRET_KEY=\n' }, 'config/env-example');
    expect(out[0]!.message).toContain('RESEND_API_KEY');
    expect(out[0]!.message).not.toContain('STRIPE_SECRET_KEY');
  });

  it('passes when every variable is documented', async () => {
    expect(await findings({ ...code, '.env.example': 'STRIPE_SECRET_KEY=\nRESEND_API_KEY=\n' }, 'config/env-example')).toEqual([]);
  });
});

describe('config/typescript-strict with project references', () => {
  it('checks the referenced configs of a solution-style tsconfig (Vite template)', async () => {
    const files = {
      'package.json': { dependencies: { vite: '6.0.0', react: '19.0.0' } },
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }',
      'tsconfig.app.json': '{ "compilerOptions": { "strict": true } }',
      'tsconfig.node.json': '{ "compilerOptions": { "strict": false } }',
    };
    const out = await findings(files, 'config/typescript-strict');
    expect(out.map((f) => f.file)).toEqual(['tsconfig.node.json']);
  });
});

describe('config/typescript-strict and TypeScript 6 defaults', () => {
  it('treats a missing "strict" as on for TypeScript >= 6, but still flags strict: false', async () => {
    const ts7 = { 'package.json': { devDependencies: { typescript: '~7.0.2' } } };
    expect(await findings({ ...ts7, 'tsconfig.json': '{ "compilerOptions": {} }' }, 'config/typescript-strict')).toEqual([]);
    const off = await findings({ ...ts7, 'tsconfig.json': '{ "compilerOptions": { "strict": false } }' }, 'config/typescript-strict');
    expect(off[0]!.title).toBe('tsconfig.json: "strict" is set to false');
    const ts5 = await findings({ 'package.json': { devDependencies: { typescript: '^5.9.0' } }, 'tsconfig.json': '{}' }, 'config/typescript-strict');
    expect(ts5[0]!.title).toContain('before 6.0');
  });
});
