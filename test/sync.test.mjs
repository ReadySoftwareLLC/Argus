import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashTree, planSync, runSync, verifyTree } from '../argus/tools/lib/sync.mjs';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../argus/tools/argus.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sync-'));
const put = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const mkSource = (files) => { const d = tmp(); put(d, 'argus/tools/argus.mjs', '// cli'); put(d, 'argus/VERSION', '1.0.0'); for (const [k, v] of Object.entries(files)) put(d, `argus/${k}`, v); return d; };
const run = (cwd, ...args) => { try { return { code: 0, out: execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: e.stdout, err: e.stderr }; } };

test('planSync classifies every case', () => {
  const acts = planSync({
    src: { a: '1', b: '2', c: '9', d: '4' },
    dest: { a: '1', b: 'old', c: 'edited', e: 'x', f: 'y' },
    locked: { b: 'old', c: 'old', e: 'x', f: 'orig' },
  });
  const m = Object.fromEntries(acts.map((a) => [a.path, a.action]));
  assert.deepEqual(m, { a: 'unchanged', b: 'update', c: 'conflict', d: 'add', e: 'remove', f: 'orphan' });
});

test('without a lock, differing files are conflicts and never silently overwritten', () => {
  const acts = planSync({ src: { a: '1' }, dest: { a: '2' }, locked: null });
  assert.equal(acts[0].action, 'conflict');
});

test('files the repo added next to vendored ones are left alone', () => {
  const acts = planSync({ src: { a: '1' }, dest: { a: '1', mine: 'x' }, locked: { a: '1' } });
  assert.equal(acts.find((a) => a.path === 'mine'), undefined);
});

test('first sync copies everything and writes a lock with hashes, version and no timestamp', () => {
  const s = mkSource({ 'quickref.md': 'q' });
  const repo = tmp();
  const res = runSync({ srcDir: path.join(s, 'argus'), destDir: path.join(repo, 'argus'), lockFile: path.join(repo, 'argus.lock'), source: { from: s, commit: null } });
  assert.equal(res.blocked.length, 0);
  assert.equal(fs.readFileSync(path.join(repo, 'argus/quickref.md'), 'utf8'), 'q');
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'argus.lock'), 'utf8'));
  assert.equal(lock.version, '1.0.0');
  assert.equal(lock.commit, null);
  assert.deepEqual(Object.keys(lock.files), ['VERSION', 'quickref.md', 'tools/argus.mjs']);
  assert.equal('synced_at' in lock, false);
});

test('second sync updates untouched files and holds back locally edited ones', () => {
  const s = mkSource({ 'a.md': 'a1', 'b.md': 'b1' });
  const repo = tmp();
  const args = () => ({ srcDir: path.join(s, 'argus'), destDir: path.join(repo, 'argus'), lockFile: path.join(repo, 'argus.lock'), source: { from: s } });
  runSync(args());
  put(repo, 'argus/b.md', 'my edit');
  put(s, 'argus/a.md', 'a2');
  put(s, 'argus/b.md', 'b2');
  const res = runSync(args());
  assert.equal(fs.readFileSync(path.join(repo, 'argus/a.md'), 'utf8'), 'a2');
  assert.equal(fs.readFileSync(path.join(repo, 'argus/b.md'), 'utf8'), 'my edit');
  assert.deepEqual(res.blocked.map((b) => b.path), ['b.md']);
  // Still flagged on the next run: the lock did not absorb the edit.
  assert.deepEqual(runSync(args()).blocked.map((b) => b.path), ['b.md']);
  const forced = runSync({ ...args(), force: true });
  assert.equal(forced.blocked.length, 0);
  assert.equal(fs.readFileSync(path.join(repo, 'argus/b.md'), 'utf8'), 'b2');
});

test('files removed upstream are deleted when untouched and kept when edited', () => {
  const s = mkSource({ 'old.md': 'o', 'gone.md': 'g' });
  const repo = tmp();
  const args = () => ({ srcDir: path.join(s, 'argus'), destDir: path.join(repo, 'argus'), lockFile: path.join(repo, 'argus.lock'), source: { from: s } });
  runSync(args());
  put(repo, 'argus/gone.md', 'edited');
  fs.rmSync(path.join(s, 'argus/old.md'));
  fs.rmSync(path.join(s, 'argus/gone.md'));
  const res = runSync(args());
  assert.equal(fs.existsSync(path.join(repo, 'argus/old.md')), false);
  assert.equal(fs.existsSync(path.join(repo, 'argus/gone.md')), true);
  assert.deepEqual(res.blocked.map((b) => b.action), ['orphan']);
});

test('dry run writes nothing', () => {
  const s = mkSource({ 'a.md': 'a' });
  const repo = tmp();
  runSync({ srcDir: path.join(s, 'argus'), destDir: path.join(repo, 'argus'), lockFile: path.join(repo, 'argus.lock'), source: { from: s }, dryRun: true });
  assert.equal(fs.existsSync(path.join(repo, 'argus')), false);
  assert.equal(fs.existsSync(path.join(repo, 'argus.lock')), false);
});

test('refuses to sync a folder onto itself', () => {
  const s = mkSource({});
  assert.throws(() => runSync({ srcDir: path.join(s, 'argus'), destDir: path.join(s, 'argus'), lockFile: path.join(s, 'l'), source: { from: s } }), /same folder/);
});

test('verifyTree reports missing and modified files', () => {
  const p = verifyTree({ dest: { a: '2' }, locked: { a: '1', b: '1' } });
  assert.deepEqual(p, [{ path: 'a', problem: 'modified' }, { path: 'b', problem: 'missing' }]);
});

test('CLI: sync, verify, edit, dry-run exit codes, relock from argus.lock', () => {
  const s = mkSource({ 'a.md': 'a1' });
  const repo = tmp();
  let r = run(repo, 'sync', '--from', s);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).added.length, 3);
  assert.equal(run(repo, 'sync', '--verify').code, 0);
  put(repo, 'argus/a.md', 'edit');
  r = run(repo, 'sync', '--verify');
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).problems, [{ path: 'a.md', problem: 'modified' }]);
  assert.equal(run(repo, 'sync', '--force').code, 0); // source comes from argus.lock
  assert.equal(fs.readFileSync(path.join(repo, 'argus/a.md'), 'utf8'), 'a1');
  assert.equal(run(repo, 'sync', '--dry-run').code, 0); // current: nothing pending
  put(s, 'argus/a.md', 'a2');
  assert.equal(run(repo, 'sync', '--dry-run').code, 1); // out of date
  assert.equal(fs.readFileSync(path.join(repo, 'argus/a.md'), 'utf8'), 'a1');
});

test('CLI: no source and no lock is a usage error', () => {
  const r = run(tmp(), 'sync');
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: argus sync/);
});

test('hashTree skips symlinks', () => {
  const d = tmp();
  put(d, 'real.md', 'r');
  fs.symlinkSync(path.join(d, 'real.md'), path.join(d, 'link.md'));
  assert.deepEqual(Object.keys(hashTree(d)), ['real.md']);
});
