import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildOnboardConfig, detectRepo, ensureGitignore, parseAlso, parseGithubRemote } from '../argus/tools/lib/onboard.mjs';
import { ensureLabels, STATES } from '../argus/tools/lib/tracker.mjs';

const CLI = new URL('../argus/tools/argus.mjs', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-onb-'));
const cli = (cwd, ...a) => spawnSync('node', [CLI, ...a], { encoding: 'utf8', cwd });

test('github remotes parse from https, ssh and git@ forms, and nothing else', () => {
  for (const u of ['https://github.com/acme/shop.git', 'https://github.com/acme/shop', 'git@github.com:acme/shop.git', 'ssh://git@github.com/acme/shop.git', 'https://user@github.com/acme/shop/']) assert.equal(parseGithubRemote(u), 'acme/shop', u);
  for (const u of ['https://gitlab.com/acme/shop.git', '', null, 'not a url']) assert.equal(parseGithubRemote(u), null, String(u));
});

test('detectRepo reports sources, and nothing when nothing is found', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  const git = (_cwd, ...a) => (a[0] === 'remote' ? 'git@github.com:acme/shop.git' : a[0] === 'symbolic-ref' ? 'origin/main' : '');
  assert.deepEqual(detectRepo(d, { git }), {
    github: { value: 'acme/shop', source: 'git remote origin' },
    default_branch: { value: 'main', source: 'git origin/HEAD' },
    test_command: { value: 'npm test', source: 'package.json scripts.test' },
  });
  const none = tmp();
  assert.deepEqual(detectRepo(none, { git: () => { throw new Error('no git'); } }), {});
});

test('a package.json without a test script gives no test command', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
  assert.equal(detectRepo(d, { git: () => { throw new Error('x'); } }).test_command, undefined);
});

test('parseAlso', () => {
  assert.deepEqual(parseAlso('api=../api, db=../db'), [{ key: 'api', path: '../api' }, { key: 'db', path: '../db' }]);
  assert.deepEqual(parseAlso(''), []);
  assert.throws(() => parseAlso('nokey'), /key=path/);
});

test('buildOnboardConfig uses detected values, lists what is unset, never invents a test command', () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, 'api'));
  const detect = (dir) => (dir === base ? { github: { value: 'acme/shop', source: 'git remote origin' }, test_command: { value: 'npm test', source: 'package.json scripts.test' } } : {});
  const r = buildOnboardConfig({ base, name: 'Shop', anchor: 'web', also: [{ key: 'api', path: 'api' }], detect });
  assert.equal(r.config.tracker.repo, 'acme/shop');
  assert.equal(r.config.repos.web.test_command, 'npm test');
  assert.equal('test_command' in r.config.repos.api, false);
  assert.ok(r.unset.some((u) => u.startsWith('repos.api.test_command')));
  assert.equal(r.evidence.web.test_command, 'package.json scripts.test');
  assert.match(r.evidence.tracker, /detected/);
});

test('buildOnboardConfig refuses to guess a missing tracker, name or repo folder', () => {
  const base = tmp();
  assert.throws(() => buildOnboardConfig({ base, name: 'S', anchor: 'a', detect: () => ({}) }), /Pass --tracker/);
  assert.throws(() => buildOnboardConfig({ base, anchor: 'a', tracker: 'o/r', detect: () => ({}) }), /usage: argus onboard/);
  assert.throws(() => buildOnboardConfig({ base, name: 'S', anchor: 'a', tracker: 'o/r', also: [{ key: 'x', path: 'nope' }], detect: () => ({}) }), /does not exist/);
  assert.throws(() => buildOnboardConfig({ base, name: 'S', anchor: 'a', tracker: 'o/r', also: [{ key: 'a', path: '.' }], detect: () => ({}) }), /unique/);
});

test('ensureLabels creates every state label plus the epic label, with a prefix from config', () => {
  const calls = [];
  const names = ensureLabels({ tracker: { repo: 'o/r', label_prefix: 'x:' } }, (args) => { calls.push(args); return ''; });
  assert.equal(names.length, STATES.length + 1);
  assert.ok(names.includes('x:ready') && names.includes('epic'));
  assert.ok(calls.every((c) => c[0] === 'label' && c.includes('--force') && c.includes('o/r')));
});

test('CLI onboard: dry run writes nothing, real run writes a valid config, refuses to overwrite', () => {
  const d = tmp();
  const dry = cli(d, 'onboard', '--name', 'Shop', '--tracker', 'acme/shop', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(path.join(d, 'argus.config.json')), false);

  const r = cli(d, 'onboard', '--name', 'Shop', '--tracker', 'acme/shop');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.gitignore_updated, true);
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /^\.argus\/$/m);
  assert.equal(cli(d, 'config').status, 0);

  const again = cli(d, 'onboard', '--name', 'Shop', '--tracker', 'acme/shop');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(cli(d, 'onboard', '--name', 'Shop2', '--tracker', 'acme/shop', '--force').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'argus.config.json'), 'utf8')).product.name, 'Shop2');
});

test('ensureGitignore is idempotent and keeps existing lines', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/');
  assert.equal(ensureGitignore(d), true);
  assert.equal(ensureGitignore(d), false);
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'node_modules/\n.argus/\n');
});
