import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';
import { audit } from '../src/audit.js';
import type { AuditOptions, AuditResult, Finding } from '../src/types.js';

const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Write a throwaway project to a temp dir. Values are strings, or objects (serialized as JSON). */
export function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'launch-check-test-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

export async function scan(files: Record<string, string | object>, only?: string | string[], opts: AuditOptions = {}): Promise<AuditResult> {
  const root = project(files);
  return audit(root, {
    git: false,
    audit: false,
    ...(only ? { only: Array.isArray(only) ? only : [only] } : {}),
    ...opts,
  });
}

/** Run a single rule against an in-memory project and return its findings. */
export async function findings(files: Record<string, string | object>, ruleId: string, opts: AuditOptions = {}): Promise<Finding[]> {
  const result = await scan(files, ruleId, opts);
  if (result.errors.length > 0) throw new Error(`rule crashed: ${result.errors.map((e) => e.message).join('; ')}`);
  return result.findings.filter((f) => f.ruleId === ruleId);
}

/* Fake credentials assembled at runtime so this file never contains a provider-shaped literal. */
const j = (...parts: string[]) => parts.join('');
export const FAKE = {
  stripeLive: j('sk_', 'live_', 'DUMMY0launch0check0test0key00'),
  stripeTest: j('sk_', 'test_', 'DUMMY0launch0check0test0key00'),
  openai: j('sk-', 'proj-', 'DUMMY-launch-check-test-not-a-real-key-0000'),
  anthropic: j('sk-', 'ant-', 'api03-', 'DUMMY-launch-check-test-not-a-real-key-0000'),
  aws: j('AK', 'IA', 'Z7DUMMY0TEST0KEY'),
  github: j('gh', 'p_', 'DUMMY0launch0check0test0key000000000'),
  google: j('AI', 'za', 'SyDUMMY-launch-check-test-key-00000'),
  pem: j('-----BEGIN ', 'RSA PRIVATE KEY', '-----'),
  dbUrl: j('postgres', 'ql://app:', 'Xk29dLq7Zt', '@db.fakeproject.supabase.co:5432/postgres'),
  jwt(role: string): string {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ iss: 'supabase', ref: 'fakeref', role, iat: 1700000000 })}.FAKE-signature-for-tests`;
  },
};

export const nextPkg = (extra: Record<string, string> = {}) => ({
  name: 'test-app',
  dependencies: { next: '16.4.6', react: '19.3.1', 'react-dom': '19.3.1', ...extra },
});
