// Config discovery and validation.
// Precedence: --config, ARGUS_CONFIG, walk up from cwd, walk up from the tool dir,
// then a single-sibling scan deduplicated by resolved .git identity.
// Zero matches -> null. One -> use it. Several distinct repos -> throw. Never silently pick.
import fs from 'node:fs';
import path from 'node:path';
import { ArgusError, readJson } from './util.mjs';

export const CONFIG_NAME = 'argus.config.json';

function walkUp(start) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a directory to a stable repo identity without running git.
 * Handles normal repos (.git dir) and worktrees (.git file -> gitdir -> commondir).
 * Returns null when dir is not inside a repo.
 */
export function gitIdentity(dir) {
  const dotGit = path.join(dir, '.git');
  if (!fs.existsSync(dotGit)) return null;
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return fs.realpathSync(dotGit);
  const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!m) return null;
  const gitdir = path.resolve(dir, m[1]);
  const commonFile = path.join(gitdir, 'commondir');
  if (fs.existsSync(commonFile)) {
    return fs.realpathSync(path.resolve(gitdir, fs.readFileSync(commonFile, 'utf8').trim()));
  }
  return fs.realpathSync(gitdir);
}

function repoRootOf(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Scan siblings of the repo containing `start` for exactly one distinct repo with a config. */
export function siblingScan(start) {
  const root = repoRootOf(start);
  if (!root) return null;
  const parent = path.dirname(root);
  const found = new Map(); // identity -> config path
  for (const name of fs.readdirSync(parent)) {
    const dir = path.join(parent, name);
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* ignore */ }
    if (!isDir) continue;
    const cfg = path.join(dir, CONFIG_NAME);
    if (!fs.existsSync(cfg)) continue;
    const id = gitIdentity(dir) ?? `nogit:${dir}`;
    if (!found.has(id)) found.set(id, cfg);
  }
  if (found.size === 0) return null;
  if (found.size === 1) return [...found.values()][0];
  throw new ArgusError(
    `Ambiguous config: ${found.size} distinct repos have ${CONFIG_NAME}:\n` +
      [...found.values()].map((p) => `  - ${p}`).join('\n') +
      '\nPass --config <path> or set ARGUS_CONFIG.'
  );
}

/** Returns { path, via } or null. */
export function discoverConfig({ flag, env = process.env, cwd = process.cwd(), toolDir } = {}) {
  if (flag) {
    const p = path.resolve(cwd, flag);
    if (!fs.existsSync(p)) throw new ArgusError(`--config not found: ${p}`);
    return { path: p, via: '--config' };
  }
  if (env.ARGUS_CONFIG) {
    const p = path.resolve(cwd, env.ARGUS_CONFIG);
    if (!fs.existsSync(p)) throw new ArgusError(`ARGUS_CONFIG not found: ${p}`);
    return { path: p, via: 'ARGUS_CONFIG' };
  }
  const up = walkUp(cwd) ?? (toolDir ? walkUp(toolDir) : null);
  if (up) return { path: up, via: 'walk-up' };
  const sib = siblingScan(cwd);
  if (sib) return { path: sib, via: 'sibling-scan' };
  return null;
}

const SLUG = /^[^/\s]+\/[^/\s]+$/;

/** Hand-rolled validator mirroring schema/config.schema.json. Returns an array of error strings. */
export function validateConfig(cfg) {
  const errs = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(cfg)) return ['config must be an object'];
  const allowed = ['$schema', 'config_version', 'product', 'orchestration_dir', 'requirements_dir', 'template_dir', 'anchor', 'repos', 'tracker', 'policies', 'limits', 'models', 'host', 'primary'];
  for (const k of Object.keys(cfg)) if (!allowed.includes(k)) errs.push(`unknown key: ${k}`);
  if (cfg.config_version !== 1) errs.push('config_version must be 1');
  if (!isObj(cfg.product) || !cfg.product.name) errs.push('product.name is required');
  if (typeof cfg.orchestration_dir !== 'string' || !cfg.orchestration_dir) errs.push('orchestration_dir is required');
  if (!isObj(cfg.repos) || Object.keys(cfg.repos).length === 0) errs.push('repos must have at least one entry');
  else {
    for (const [name, r] of Object.entries(cfg.repos)) {
      if (!isObj(r) || typeof r.path !== 'string') errs.push(`repos.${name}.path is required`);
      if (r?.github && !SLUG.test(r.github)) errs.push(`repos.${name}.github must be owner/name`);
    }
    if (typeof cfg.anchor !== 'string' || !cfg.repos[cfg.anchor]) errs.push('anchor must be a key in repos');
  }
  if (!isObj(cfg.tracker) || cfg.tracker.type !== 'github') errs.push('tracker.type must be "github"');
  else if (!SLUG.test(cfg.tracker.repo ?? '')) errs.push('tracker.repo must be owner/name');
  for (const [name, p] of Object.entries(cfg.policies ?? {})) {
    const has = ['answer', 'file'].filter((k) => p?.[k] !== undefined).length;
    if (has !== 1) errs.push(`policies.${name} needs exactly one of answer or file`);
  }
  const lim = cfg.limits ?? {};
  if (lim.max_concurrent !== undefined && !(Number.isInteger(lim.max_concurrent) && lim.max_concurrent >= 1)) errs.push('limits.max_concurrent must be an integer >= 1');
  if (lim.discovery_rounds !== undefined && !(Number.isInteger(lim.discovery_rounds) && lim.discovery_rounds >= 1)) errs.push('limits.discovery_rounds must be an integer >= 1');
  if (lim.epic_budget_usd != null && !(typeof lim.epic_budget_usd === 'number' && lim.epic_budget_usd >= 0)) errs.push('limits.epic_budget_usd must be a number >= 0 or null');
  if (cfg.host?.dispatch && !['claude-code', 'manual'].includes(cfg.host.dispatch)) errs.push('host.dispatch must be claude-code or manual');
  return errs;
}

export const DEFAULT_LIMITS = { discovery_rounds: 2, max_concurrent: 3, epic_budget_usd: null, prompt_token_budget: 2500 };

/** Load, validate, and resolve paths. Throws with all errors listed. */
export function loadConfig(found) {
  const cfg = readJson(found.path);
  const errs = validateConfig(cfg);
  if (errs.length) throw new ArgusError(`Invalid ${found.path}:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
  const base = path.dirname(found.path);
  const abs = (p) => path.resolve(base, p);
  const repos = {};
  for (const [name, r] of Object.entries(cfg.repos)) {
    repos[name] = { ...r, abs_path: abs(r.path), github: r.github ?? cfg.tracker.repo };
  }
  return {
    ...cfg,
    limits: { ...DEFAULT_LIMITS, ...(cfg.limits ?? {}) },
    host: { dispatch: 'manual', ...(cfg.host ?? {}) },
    repos,
    _file: found.path,
    _via: found.via,
    _base: base,
    _orchestration_abs: abs(cfg.orchestration_dir),
  };
}

/** Where a story's requirements file lives. */
export function requirementsPath(config, issue) {
  const root = config.requirements_dir ? path.resolve(config._base, config.requirements_dir) : config._orchestration_abs;
  return path.join(root, String(issue), 'requirements.md');
}

export function storyDir(config, issue) {
  return path.join(config._orchestration_abs, String(issue));
}

/** Policies filtered by story tags. A policy with no applies_to always applies. */
export function applicablePolicies(config, tags = []) {
  return Object.entries(config.policies ?? {})
    .filter(([, p]) => !p.applies_to || p.applies_to.some((t) => tags.includes(t)))
    .map(([name, p]) => ({ name, ...p }));
}
