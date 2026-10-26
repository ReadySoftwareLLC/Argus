import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverConfig, gitIdentity, validateConfig, loadConfig, applicablePolicies, requirementsPath } from '../argus/tools/lib/config.mjs';

const example = JSON.parse(fs.readFileSync(new URL('../argus/argus.config.example.json', import.meta.url), 'utf8'));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-'));
}
function writeCfg(dir, cfg = example) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'argus.config.json'), JSON.stringify(cfg));
}
function fakeRepo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

test('example config is valid', () => {
  assert.deepEqual(validateConfig(example), []);
});

test('validation catches the main mistakes', () => {
  const bad = { ...example, anchor: 'nope', tracker: { type: 'jira', repo: 'x' }, extra: 1, policies: { p: {} } };
  const errs = validateConfig(bad).join('\n');
  assert.match(errs, /anchor must be a key/);
  assert.match(errs, /tracker.type/);
  assert.match(errs, /unknown key: extra/);
  assert.match(errs, /policies.p needs exactly one/);
});

test('policy with both answer and file is rejected', () => {
  const bad = { ...example, policies: { p: { answer: 'a', file: 'f' } } };
  assert.match(validateConfig(bad).join(), /exactly one/);
});

test('explicit flag beats env beats walk-up', () => {
  const root = tmp();
  writeCfg(path.join(root, 'a'));
  writeCfg(path.join(root, 'b'));
  writeCfg(path.join(root, 'c'));
  const flag = discoverConfig({ flag: path.join(root, 'a/argus.config.json'), env: { ARGUS_CONFIG: path.join(root, 'b/argus.config.json') }, cwd: path.join(root, 'c') });
  assert.equal(flag.via, '--config');
  const env = discoverConfig({ env: { ARGUS_CONFIG: path.join(root, 'b/argus.config.json') }, cwd: path.join(root, 'c') });
  assert.equal(env.via, 'ARGUS_CONFIG');
  const up = discoverConfig({ env: {}, cwd: path.join(root, 'c') });
  assert.equal(up.via, 'walk-up');
});

test('missing explicit config throws', () => {
  assert.throws(() => discoverConfig({ flag: '/no/such/file.json', env: {} }), /not found/);
});

test('sibling scan: zero matches returns null', () => {
  const root = tmp();
  fakeRepo(path.join(root, 'ui'));
  assert.equal(discoverConfig({ env: {}, cwd: path.join(root, 'ui') }), null);
});

test('sibling scan: one match is used', () => {
  const root = tmp();
  fakeRepo(path.join(root, 'ui'));
  fakeRepo(path.join(root, 'anchor'));
  writeCfg(path.join(root, 'anchor'));
  const found = discoverConfig({ env: {}, cwd: path.join(root, 'ui') });
  assert.equal(found.via, 'sibling-scan');
  assert.equal(found.path, path.join(root, 'anchor/argus.config.json'));
});

test('sibling scan: several distinct repos throws, never picks', () => {
  const root = tmp();
  fakeRepo(path.join(root, 'ui'));
  for (const n of ['one', 'two']) {
    fakeRepo(path.join(root, n));
    writeCfg(path.join(root, n));
  }
  assert.throws(() => discoverConfig({ env: {}, cwd: path.join(root, 'ui') }), /Ambiguous config: 2 distinct repos/);
});

test('sibling scan dedupes worktrees of the same repo by .git identity', () => {
  const root = tmp();
  fakeRepo(path.join(root, 'ui'));
  const main = path.join(root, 'anchor');
  fakeRepo(main);
  writeCfg(main);
  // a worktree: .git file -> gitdir inside main/.git/worktrees/wt1, with commondir pointing back
  const wtGit = path.join(main, '.git/worktrees/wt1');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..');
  const wt = path.join(root, 'anchor-wt1');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  writeCfg(wt);
  assert.equal(gitIdentity(wt), gitIdentity(main));
  const found = discoverConfig({ env: {}, cwd: path.join(root, 'ui') });
  assert.equal(found.via, 'sibling-scan');
});

test('loadConfig applies defaults and resolves paths', () => {
  const root = tmp();
  writeCfg(root);
  const cfg = loadConfig({ path: path.join(root, 'argus.config.json'), via: 'test' });
  assert.equal(cfg.limits.max_concurrent, 3);
  assert.equal(cfg.host.dispatch, 'manual');
  assert.equal(cfg.repos.web.abs_path, root);
  assert.equal(cfg.repos.web.github, 'acme-co/acme-web');
  assert.equal(requirementsPath(cfg, 7), path.join(root, 'orchestration/7/requirements.md'));
});

test('requirements_dir overrides the default location', () => {
  const root = tmp();
  writeCfg(root, { ...example, requirements_dir: 'docs/reqs' });
  const cfg = loadConfig({ path: path.join(root, 'argus.config.json'), via: 'test' });
  assert.equal(requirementsPath(cfg, 7), path.join(root, 'docs/reqs/7/requirements.md'));
});

test('policies filter by tags; untagged policies always apply', () => {
  const root = tmp();
  writeCfg(root);
  const cfg = loadConfig({ path: path.join(root, 'argus.config.json'), via: 'test' });
  assert.deepEqual(applicablePolicies(cfg, []).map((p) => p.name), ['audit-trail']);
  assert.deepEqual(applicablePolicies(cfg, ['ui']).map((p) => p.name).sort(), ['audit-trail', 'money-display']);
});
