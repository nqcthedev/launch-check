import type { Rule } from '../types.js';
import { buildRules } from './build.js';
import { codeRules } from './code.js';
import { depRules } from './deps.js';
import { nextRules } from './nextjs.js';
import { secretRules } from './secrets.js';
import { supabaseRules } from './supabase.js';
import { webRules } from './web.js';

/** Every built-in rule, in report order. */
export const allRules: Rule[] = [
  ...secretRules,
  ...supabaseRules,
  ...nextRules,
  ...webRules,
  ...codeRules,
  ...depRules,
  ...buildRules,
];

export function getRule(id: string): Rule | undefined {
  return allRules.find((r) => r.id === id);
}
