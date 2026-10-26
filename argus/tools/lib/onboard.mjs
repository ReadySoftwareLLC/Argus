// `argus onboard`: turn a bare repo into a valid argus.config.json without guessing.
// Detected values carry their source. Anything not detected and not given stays unset and is listed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArgusError } from './util.mjs';
import { validateConfig } from './config.mjs';

/** owner/name from an https, ssh or git@ github remote URL. Null for anything else. */
export function parseGithubRemote(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const defaultGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** What can be read from a repo folder. Every value names its source; absent means not detected. */
export function detectRepo(dir, { git = defaultGit } = {}) {
  const found = {};
  const tryGit = (...a) => { try { return git(dir, ...a) || null; } catch { return null; } };
  const gh = parseGithubRemote(tryGit('remote', 'get-url', 'origin'));
  if (gh) found.github = { value: gh, source: 'git remote origin' };
  const head = tryGit('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head) found.default_branch = { value: head.replace(/^origin\//, ''), source: 'git origin/HEAD' };
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (typeof j.scripts?.test === 'string' && j.scripts.test.trim()) found.test_command = { value: 'npm test', source: 'package.json scripts.test' };
    } catch { /* unreadable package.json: nothing detected */ }
  }
  return found;
}

const KEY = /^[A-Za-z][\w-]*$/;

/** "api=../acme-api,db=../acme-db" -> [{key, path}] */
export function parseAlso(s) {
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    const key = i > 0 ? x.slice(0, i) : '';
    const p = i > 0 ? x.slice(i + 1) : '';
    if (!KEY.test(key) || !p) throw new ArgusError(`--also entries look like key=path (got "${x}")`);
    return { key, path: p };
  });
}

/**
 * Build the config. `answers` are what the human supplied; `detect(dir)` reads a repo folder.
 * Returns { config, evidence, unset }.
 */
export function buildOnboardConfig({ base, name, tracker, anchor, also = [], orchestrationDir = 'orchestration', primary, detect = (d) => detectRepo(d) }) {
  if (!name || typeof name !== 'string') throw new ArgusError('usage: argus onboard --name "<product name>" [--tracker owner/repo] [--anchor key] [--also key=path,...]');
  const anchorKey = anchor ?? (path.basename(base).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'main');
  if (!KEY.test(anchorKey)) throw new ArgusError(`anchor key "${anchorKey}" is not usable. Pass --anchor <key> (letters, digits, - and _).`);
  const entries = [{ key: anchorKey, path: '.' }, ...also];
  if (new Set(entries.map((e) => e.key)).size !== entries.length) throw new ArgusError('Repo keys must be unique (the anchor key is also taken by --also).');

  const evidence = {};
  const unset = [];
  const repos = {};
  for (const e of entries) {
    const dir = path.resolve(base, e.path);
    if (!fs.existsSync(dir)) throw new ArgusError(`repos.${e.key}: ${e.path} does not exist (resolved ${dir})`);
    const d = detect(dir);
    repos[e.key] = { path: e.path };
    evidence[e.key] = {};
    for (const f of ['github', 'default_branch', 'test_command']) {
      if (d[f]) { repos[e.key][f] = d[f].value; evidence[e.key][f] = d[f].source; }
    }
    if (!repos[e.key].test_command) unset.push(`repos.${e.key}.test_command: not detected, workers will have no test command until you set it`);
  }
  let trackerRepo = tracker;
  if (trackerRepo) evidence.tracker = 'given with --tracker';
  else if (repos[anchorKey].github) { trackerRepo = repos[anchorKey].github; evidence.tracker = `detected: ${evidence[anchorKey].github}`; }
  else throw new ArgusError(`Could not detect a GitHub remote for ${anchorKey}. Pass --tracker owner/repo.`);

  const config = {
    $schema: './argus/schema/config.schema.json',
    config_version: 1,
    product: { name },
    orchestration_dir: orchestrationDir,
    anchor: anchorKey,
    repos,
    tracker: { type: 'github', repo: trackerRepo },
    host: { dispatch: 'manual' },
  };
  if (primary) config.primary = primary;
  unset.push('product.facts_path: not set (no file of product facts for discovery)');
  unset.push('policies: none recorded (add standing policies as the human states them, see argus/discovery/standing-policies.md)');
  unset.push('limits.epic_budget_usd: no cap (null)');
  const errs = validateConfig(config);
  if (errs.length) throw new ArgusError(`Generated config is invalid:\n- ${errs.join('\n- ')}`);
  return { config, evidence, unset };
}

/** Ensure .gitignore ignores the derived index. Returns true when it changed the file. */
export function ensureGitignore(base) {
  const f = path.join(base, '.gitignore');
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (cur.split('\n').some((l) => l.trim() === '.argus/')) return false;
  fs.writeFileSync(f, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.argus/\n`);
  return true;
}
