import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { FindingInput } from '../types.js';
import { defineRule } from './helpers.js';

export interface BuildError {
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Parse build output (next build, tsc, vite/rollup, esbuild) into individual errors. */
export function parseBuildOutput(output: string, root = ''): BuildError[] {
  const text = output.replace(ANSI_RE, '').replace(/\r/g, '');
  const lines = text.split('\n');
  const errors: BuildError[] = [];
  const seen = new Set<string>();
  const norm = (f: string) => {
    let p = f.trim().replace(/^\.\//, '');
    if (root && isAbsolute(p)) p = relative(root, p);
    return p.replace(/\\/g, '/');
  };
  const push = (e: BuildError) => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(e);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let m: RegExpExecArray | null;
    // tsc: src/a.ts(12,5): error TS2322: msg   |   src/a.ts:12:5 - error TS2322: msg
    if ((m = /^(.+?\.[cm]?[jt]sx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(l))) {
      push({ file: norm(m[1]!), line: +m[2]!, column: +m[3]!, code: m[4]!, message: m[5]! });
      continue;
    }
    if ((m = /^(.+?\.[cm]?[jt]sx?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.*)$/.exec(l))) {
      push({ file: norm(m[1]!), line: +m[2]!, column: +m[3]!, code: m[4]!, message: m[5]! });
      continue;
    }
    // next build: "./app/page.tsx:12:5" followed by "Type error: msg"
    if ((m = /^(\.\/.+?\.[cm]?[jt]sx?):(\d+):(\d+)\s*$/.exec(l))) {
      const next = lines.slice(i + 1, i + 4).find((x) => x.trim().length > 0) ?? '';
      const t = /^(Type error|Error|Module not found|SyntaxError)[:]?\s*(.*)$/.exec(next.trim());
      if (t) {
        push({ file: norm(m[1]!), line: +m[2]!, column: +m[3]!, code: t[1] === 'Type error' ? 'type-error' : t[1]!.toLowerCase().replace(/\s+/g, '-'), message: t[2] || t[1]! });
        continue;
      }
    }
    // Turbopack / webpack: "Module not found: Can't resolve 'x'" with file on previous line
    if ((m = /Module not found: (?:Error: )?Can't resolve '([^']+)'/.exec(l))) {
      const prev = lines.slice(Math.max(0, i - 3), i).reverse().find((x) => /\.[cm]?[jt]sx?(:\d+)?/.test(x)) ?? '';
      const fm = /(\.?\/?[\w@./()[\]-]+\.[cm]?[jt]sx?)(?::(\d+))?/.exec(prev);
      push({ ...(fm ? { file: norm(fm[1]!) } : {}), ...(fm?.[2] ? { line: +fm[2] } : {}), code: 'module-not-found', message: `Can't resolve '${m[1]}'` });
      continue;
    }
    // vite / rollup
    if ((m = /Rollup failed to resolve import "([^"]+)" from "([^"]+)"/.exec(l))) {
      push({ file: norm(m[2]!), code: 'unresolved-import', message: `Failed to resolve import "${m[1]}"` });
      continue;
    }
    // esbuild: ✘ [ERROR] msg  ... then "    src/a.ts:3:7:"
    if ((m = /^\s*(?:✘|X)\s+\[ERROR\]\s+(.*)$/.exec(l))) {
      const loc = lines.slice(i + 1, i + 5).map((x) => /^\s+(.+?\.[cm]?[jt]sx?):(\d+):(\d+):\s*$/.exec(x)).find(Boolean);
      push({ ...(loc ? { file: norm(loc[1]!), line: +loc[2]!, column: +loc[3]! } : {}), code: 'esbuild', message: m[1]! });
      continue;
    }
    // vite: "[vite:esbuild] Transform failed" / "error during build:" + "file: /abs/src/a.tsx:3:4"
    if ((m = /^file:\s+(.+?\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(l))) {
      const msg = lines.slice(Math.max(0, i - 3), i).reverse().find((x) => /error|failed/i.test(x)) ?? 'Build error';
      push({ file: norm(m[1]!), line: +m[2]!, column: +m[3]!, code: 'vite', message: msg.trim() });
    }
  }
  return errors;
}

function runBuild(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const cap = (d: Buffer) => {
      output += d.toString();
      if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + String(e), timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut, ms: Date.now() - started });
    });
  });
}

export const buildRule = defineRule({
  id: 'build/production-build',
  title: 'Production build fails',
  category: 'build',
  severity: 'high',
  why: 'If `build` fails, the app cannot be deployed (or the platform keeps serving an old version). Each error below blocks the release.',
  fix: 'Fix the reported errors locally with the same command the host runs (`npm run build`), then commit.',
  appliesTo: (ctx) => ctx.options.build === true,
  async run(ctx) {
    const script = ctx.pkg?.scripts?.build;
    if (!script) return [{ severity: 'info', title: 'No build script', message: 'package.json has no "build" script; --build was skipped.', file: 'package.json' }];
    if (!existsSync(join(ctx.root, 'node_modules'))) {
      return [{ severity: 'info', title: 'Build skipped: dependencies not installed', message: 'Run your package manager install first, then re-run with --build.', file: 'package.json' }];
    }
    const pm = ctx.detection.packageManager ?? 'npm';
    const res = await runBuild(pm, ['run', 'build'], ctx.root, ctx.options.buildTimeoutMs ?? 10 * 60_000);
    const seconds = (res.ms / 1000).toFixed(1);
    if (res.code === 0) {
      return [{ severity: 'info', title: `Build succeeded (${seconds}s)`, message: `\`${pm} run build\` (${script}) completed without errors.`, file: 'package.json', fix: 'No action needed.' }];
    }
    const errors = parseBuildOutput(res.output, ctx.root);
    if (errors.length === 0) {
      const tail = res.output.replace(ANSI_RE, '').trim().split('\n').slice(-12).join('\n');
      return [
        {
          severity: 'high',
          title: res.timedOut ? `Build timed out after ${seconds}s` : `\`${pm} run build\` exited with code ${res.code}`,
          message: `Last lines of output:\n${tail}`,
          file: 'package.json',
        },
      ];
    }
    const out: FindingInput[] = errors.slice(0, 25).map((e) => ({
      title: `Build error${e.code ? ` ${e.code}` : ''}${e.file ? ` in ${e.file}` : ''}`,
      message: e.message,
      ...(e.file ? { file: e.file } : {}),
      ...(e.line ? { line: e.line } : {}),
      ...(e.column ? { column: e.column } : {}),
    }));
    if (errors.length > 25) out.push({ severity: 'info', title: `${errors.length - 25} more build errors`, message: 'Run the build locally for the full list.' });
    return out;
  },
});

export const buildRules = [buildRule];
