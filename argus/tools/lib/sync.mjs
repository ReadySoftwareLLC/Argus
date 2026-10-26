// `argus sync`: vendor the argus/ folder into a consuming repo and record what was copied in argus.lock.
// The lock holds a sha256 per file, so a later sync can tell "upstream changed" (safe to update)
// from "someone edited the vendored file" (never overwritten without --force). Customize through
// template_dir, not by editing vendored files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArgusError } from './util.mjs';

export const LOCK_VERSION = 1;
export const LOCK_NAME = 'argus.lock';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Relative posix path -> sha256 for every regular file under dir. Symlinks are skipped. */
export function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out[path.relative(dir, full).split(path.sep).join('/')] = sha(fs.readFileSync(full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function readLock(file) {
  if (!fs.existsSync(file)) return null;
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ArgusError(`${file} is not valid JSON: ${e.message}`); }
  if (lock.lock_version !== LOCK_VERSION) throw new ArgusError(`${file} has lock_version ${lock.lock_version}; this tool reads ${LOCK_VERSION}`);
  if (!lock.files || typeof lock.files !== 'object') throw new ArgusError(`${file} has no "files" map`);
  return lock;
}

/**
 * Decide what to do with each file. Pure: no disk access.
 * src/dest/locked are { relpath: sha256 }. Returns a list of { path, action, reason }.
 *  add        in source, absent in dest
 *  update     source differs from dest, and dest still matches the lock (or there is no lock and dest is absent)
 *  conflict   source differs from dest and dest was edited since the lock (or no lock to tell)
 *  remove     gone from source, dest unmodified
 *  orphan     gone from source, dest modified: kept, reported
 *  unchanged  identical
 */
export function planSync({ src, dest, locked }) {
  const acts = [];
  for (const p of Object.keys(src)) {
    if (!(p in dest)) { acts.push({ path: p, action: 'add' }); continue; }
    if (dest[p] === src[p]) { acts.push({ path: p, action: 'unchanged' }); continue; }
    if (!locked) acts.push({ path: p, action: 'conflict', reason: 'differs from source and there is no argus.lock to say whether it was edited' });
    else if (locked[p] === dest[p]) acts.push({ path: p, action: 'update' });
    else acts.push({ path: p, action: 'conflict', reason: locked[p] === undefined ? 'not in argus.lock but differs from source' : 'edited locally since the last sync' });
  }
  for (const p of Object.keys(dest)) {
    if (p in src) continue;
    if (!locked || !(p in locked)) continue; // not ours (never vendored), leave alone
    acts.push(locked[p] === dest[p] ? { path: p, action: 'remove' } : { path: p, action: 'orphan', reason: 'removed upstream but edited locally' });
  }
  return acts.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Files in dest that differ from the lock. Offline integrity check, no source needed. */
export function verifyTree({ dest, locked }) {
  const problems = [];
  for (const [p, h] of Object.entries(locked)) {
    if (!(p in dest)) problems.push({ path: p, problem: 'missing' });
    else if (dest[p] !== h) problems.push({ path: p, problem: 'modified' });
  }
  return problems;
}

/** Find the argus/ folder in a source: the dir itself if it looks like one, else <dir>/argus. */
export function sourceArgusDir(dir) {
  const looksLikeArgus = (d) => fs.existsSync(path.join(d, 'tools', 'argus.mjs'));
  if (looksLikeArgus(dir)) return dir;
  if (looksLikeArgus(path.join(dir, 'argus'))) return path.join(dir, 'argus');
  throw new ArgusError(`${dir} does not contain an argus/ folder (no tools/argus.mjs)`);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Commit of a local checkout, or null when it is not a git repo. Never guessed. */
export function localCommit(dir) {
  try { return git(dir, 'rev-parse', 'HEAD'); } catch { return null; }
}

/**
 * Resolve --from into a local directory. A path is used in place. Anything else is treated as a git URL
 * and cloned to a temp dir. Returns { dir, commit, cleanup }.
 */
export function resolveSource({ from, ref }) {
  if (fs.existsSync(from)) {
    if (ref) throw new ArgusError('--ref only applies to a git URL source. Check out the ref in the local source first.');
    return { dir: path.resolve(from), commit: localCommit(path.resolve(from)), cleanup() {} };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-src-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    try {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', ...(ref ? ['--branch', ref] : []), from, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (!ref) throw e;
      // --branch does not accept a bare commit sha. Fall back to a full clone and checkout.
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp);
      execFileSync('git', ['clone', '--quiet', from, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('git', ['checkout', '--quiet', ref], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } catch (e) {
    cleanup();
    throw new ArgusError(`Could not fetch ${from}${ref ? ` at ${ref}` : ''}: ${String(e.stderr ?? e.message).trim()}`);
  }
  return { dir: tmp, commit: localCommit(tmp), cleanup };
}

export function readVersion(argusDir) {
  const f = path.join(argusDir, 'VERSION');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
}

/**
 * Run a sync. Returns { actions, applied, lock }. With dryRun nothing is written.
 * A conflict blocks that file only; the rest still update, and the result lists the conflicts so the
 * caller can exit non-zero. force overwrites conflicts and orphans.
 */
export function runSync({ srcDir, destDir, lockFile, source, dryRun = false, force = false }) {
  if (path.resolve(srcDir) === path.resolve(destDir)) throw new ArgusError('Source and destination are the same folder.');
  const prior = readLock(lockFile);
  const src = hashTree(srcDir);
  const dest = hashTree(destDir);
  const actions = planSync({ src, dest, locked: prior?.files ?? null });
  const applied = [];
  if (!dryRun) {
    for (const a of actions) {
      const to = path.join(destDir, a.path);
      const doCopy = a.action === 'add' || a.action === 'update' || (force && a.action === 'conflict');
      const doRemove = a.action === 'remove' || (force && a.action === 'orphan');
      if (doCopy) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(srcDir, a.path), to);
        fs.chmodSync(to, fs.statSync(path.join(srcDir, a.path)).mode);
        applied.push(a.path);
      } else if (doRemove) {
        fs.rmSync(to, { force: true });
        applied.push(a.path);
      }
    }
  }
  const blocked = actions.filter((a) => (a.action === 'conflict' || a.action === 'orphan') && !(force && !dryRun));
  const next = {
    lock_version: LOCK_VERSION,
    source: source.from,
    ref: source.ref ?? null,
    commit: source.commit ?? null,
    version: readVersion(srcDir),
    // Held-back files keep their old lock entry, so a later sync still sees them as edited.
    files: Object.fromEntries(Object.keys(src).map((p) => {
      const held = blocked.find((b) => b.path === p);
      if (held) return [p, prior?.files?.[p] ?? src[p]];
      return [p, src[p]];
    }).concat(blocked.filter((b) => b.action === 'orphan' && prior?.files?.[b.path]).map((b) => [b.path, prior.files[b.path]])).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  if (!dryRun) fs.writeFileSync(lockFile, `${JSON.stringify(next, null, 2)}\n`);
  return { actions, applied, blocked, lock: next, prior };
}
