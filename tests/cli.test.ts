import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { project } from './helpers.js';

const broken = join(import.meta.dirname, '..', 'fixtures', 'vibe-app-broken');
const fixed = join(import.meta.dirname, '..', 'fixtures', 'vibe-app-fixed');

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await main(args);
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('exits 1 on the broken fixture (critical findings) and 0 on the fixed one', async () => {
    expect((await run([broken, '--no-audit', '--no-git', '--no-color'])).code).toBe(1);
    expect((await run([fixed, '--no-audit', '--no-git', '--no-color', '--fail-on', 'low'])).code).toBe(0);
  });

  it('respects --fail-on', async () => {
    const dir = project({ 'package.json': { name: 'x' }, 'src/a.ts': 'eval(x)' });
    expect((await run([dir, '--no-audit', '--no-git', '--fail-on', 'critical'])).code).toBe(0);
    expect((await run([dir, '--no-audit', '--no-git', '--fail-on', 'high'])).code).toBe(1);
    expect((await run([dir, '--no-audit', '--no-git', '--fail-on', 'none'])).code).toBe(0);
  });

  it('prints parseable JSON with --json', async () => {
    const { stdout } = await run([broken, '--json', '--no-audit', '--no-git']);
    const json = JSON.parse(stdout) as { findings: Array<{ ruleId: string }>; score: number };
    expect(json.findings.length).toBeGreaterThan(20);
    expect(typeof json.score).toBe('number');
  });

  it('writes a Markdown report with --md', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lc-md-')), 'report.md');
    const { stdout } = await run([broken, '--md', file, '--prepared-by', 'Example Studio', '--no-audit', '--no-git', '--no-color']);
    expect(stdout).toContain('Markdown report written to');
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('# Production Readiness Report: taskpilot');
    expect(md).toContain('| **Prepared by** | Example Studio |');
  });

  it('never prints the fake secrets themselves', async () => {
    const { stdout } = await run([broken, '--json', '--no-audit', '--no-git']);
    expect(stdout).not.toContain('DUMMY-launch-check-fixture-not-a-real-key');
    expect(stdout).not.toContain('FAKE-launch-check-fixture-signature');
  });

  it('filters with --only', async () => {
    const { stdout } = await run([broken, '--json', '--only', 'supabase', '--no-audit', '--no-git']);
    const json = JSON.parse(stdout) as { findings: Array<{ ruleId: string }> };
    expect(new Set(json.findings.map((f) => f.ruleId.split('/')[0]))).toEqual(new Set(['supabase']));
  });

  it('returns 2 on usage errors', async () => {
    expect((await run(['--fail-on', 'severe'])).code).toBe(2);
    expect((await run(['--only', 'nope'])).code).toBe(2);
    expect((await run(['--unknown-flag'])).code).toBe(2);
    expect((await run(['/does/not/exist'])).code).toBe(2);
  });

  it('prints help, version and the rule list', async () => {
    expect((await run(['--help'])).stdout).toContain('Usage');
    expect((await run(['--version'])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect((await run(['--list-rules', '--no-color'])).stdout).toContain('supabase/rls-disabled');
  });
});
