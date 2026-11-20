import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { SEVERITIES, type ResolvedConfig, type Severity } from './types.js';
import { parseJsonc } from './utils/text.js';

export const CONFIG_FILES = ['launch-check.config.json', '.launch-checkrc.json', '.launch-checkrc'];

export interface UserConfig {
  ignore?: string[];
  rules?: Record<string, Severity | 'off'>;
  failOn?: Severity | 'none';
  thresholds?: { consoleLog?: number; anyPerKloc?: number };
}

export class ConfigError extends Error {}

export const DEFAULT_CONFIG: Omit<ResolvedConfig, 'configFile'> = {
  ignore: [],
  rules: {},
  failOn: 'critical',
  consoleLogThreshold: 5,
  anyDensityThreshold: 5,
};

function validate(raw: unknown, source: string): UserConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: config must be a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;
  const known = new Set(['$schema', 'ignore', 'rules', 'failOn', 'thresholds']);
  for (const key of Object.keys(cfg)) {
    if (!known.has(key)) throw new ConfigError(`${source}: unknown key "${key}" (expected ignore, rules, failOn, thresholds)`);
  }
  if (cfg.ignore !== undefined && (!Array.isArray(cfg.ignore) || cfg.ignore.some((g) => typeof g !== 'string'))) {
    throw new ConfigError(`${source}: "ignore" must be an array of glob strings`);
  }
  if (cfg.rules !== undefined) {
    if (typeof cfg.rules !== 'object' || cfg.rules === null) throw new ConfigError(`${source}: "rules" must be an object`);
    for (const [id, value] of Object.entries(cfg.rules)) {
      if (value !== 'off' && !SEVERITIES.includes(value as Severity)) {
        throw new ConfigError(`${source}: rules["${id}"] must be "off" or one of ${SEVERITIES.join(', ')}`);
      }
    }
  }
  if (cfg.failOn !== undefined && cfg.failOn !== 'none' && !SEVERITIES.includes(cfg.failOn as Severity)) {
    throw new ConfigError(`${source}: "failOn" must be "none" or one of ${SEVERITIES.join(', ')}`);
  }
  return cfg as UserConfig;
}

export function loadConfig(root: string, explicitPath?: string): ResolvedConfig {
  let file: string | null = null;
  let user: UserConfig = {};
  if (explicitPath) {
    const abs = isAbsolute(explicitPath) ? explicitPath : join(process.cwd(), explicitPath);
    if (!existsSync(abs)) throw new ConfigError(`Config file not found: ${explicitPath}`);
    const parsed = parseJsonc(readFileSync(abs, 'utf8'));
    if (parsed === null) throw new ConfigError(`${explicitPath}: invalid JSON`);
    user = validate(parsed, explicitPath);
    file = relative(root, abs) || abs;
  } else {
    for (const name of CONFIG_FILES) {
      const abs = join(root, name);
      if (!existsSync(abs)) continue;
      const parsed = parseJsonc(readFileSync(abs, 'utf8'));
      if (parsed === null) throw new ConfigError(`${name}: invalid JSON`);
      user = validate(parsed, name);
      file = name;
      break;
    }
    if (!file && existsSync(join(root, 'package.json'))) {
      const pkg = parseJsonc<Record<string, unknown>>(readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg && pkg.launchCheck !== undefined) {
        user = validate(pkg.launchCheck, 'package.json#launchCheck');
        file = 'package.json#launchCheck';
      }
    }
  }
  return {
    ignore: user.ignore ?? DEFAULT_CONFIG.ignore,
    rules: user.rules ?? DEFAULT_CONFIG.rules,
    failOn: user.failOn ?? DEFAULT_CONFIG.failOn,
    consoleLogThreshold: user.thresholds?.consoleLog ?? DEFAULT_CONFIG.consoleLogThreshold,
    anyDensityThreshold: user.thresholds?.anyPerKloc ?? DEFAULT_CONFIG.anyDensityThreshold,
    configFile: file,
  };
}
