import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { derivedFields } from '../argus/tools/argus.mjs';
import { loadConfig } from '../argus/tools/lib/config.mjs';

const CLI = new URL('../argus/tools/argus.mjs', import.meta.url).pathname;
const example = JSON.parse(fs.readFileSync(new URL('../argus/argus.config.example.json', import.meta.url), 'utf8'));

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cli-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'argus.config.json'), JSON.stringify(example));
  return root;
}
const run = (root, ...args) => spawnSync('node', [CLI, ...args, '--config', path.join(root, 'argus.config.json')], { encoding: 'utf8', cwd: root });

test('help prints without a config', () => {
  const r = spawnSync('node', [CLI, 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /report-check/);
});

test('config command resolves and prints', () => {
  const root = sandbox();
  const r = run(root, 'config');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).product, 'Acme Shop');
});

test('invalid config exits non-zero with all errors', () => {
  const root = sandbox();
  fs.writeFileSync(path.join(root, 'argus.config.json'), JSON.stringify({ ...example, anchor: 'zzz' }));
  const r = run(root, 'config');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /anchor must be a key/);
});

test('init scaffolds once and is idempotent', () => {
  const root = sandbox();
  const first = JSON.parse(run(root, 'init', '12').stdout);
  assert.ok(first.created.some((p) => p.endsWith('requirements.md')));
  assert.ok(first.created.some((p) => p.endsWith('status.md')));
  fs.writeFileSync(path.join(root, 'orchestration/12/requirements.md'), 'EDITED');
  const second = JSON.parse(run(root, 'init', '12').stdout);
  assert.deepEqual(second.created, []);
  assert.equal(fs.readFileSync(path.join(root, 'orchestration/12/requirements.md'), 'utf8'), 'EDITED');
});

test('status rebuilds the board from status.json files', () => {
  const root = sandbox();
  run(root, 'init', '12');
  const r = run(root, 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'orchestration/status.md'), 'utf8'), /\| #12 \|/);
});

test('render --story injects config facts, lint passes, no guessing', () => {
  const root = sandbox();
  const data = path.join(root, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ title: 'Add export', branch: 'argus/12-export', summary: 's', acceptance_criteria: ['a'], out_of_scope: ['b'], tags: ['ui'], repo_key: 'api' }));
  const out = path.join(root, 'prompt.md');
  const r = run(root, 'render', 'worker-prompt', '--data', data, '--story', '12', '--out', out);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /Test: `make test`/);
  assert.match(text, /\.\.\/acme-api\/docs\/rules/);
  assert.match(text, /money-display: Two decimals/);
  assert.match(text, /audit-trail: see `docs\/policies\/audit.md`/);
  assert.equal(run(root, 'lint', out).status, 0);
});

test('render fails when the repo has no rules path (never assumed)', () => {
  const root = sandbox();
  const data = path.join(root, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ title: 't', branch: 'b', summary: 's', acceptance_criteria: ['a'], out_of_scope: ['b'], repo_key: 'db' }));
  const r = run(root, 'render', 'worker-prompt', '--data', data, '--story', '12');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /rules/);
});

test('render fails when the repo has no test command (never assumed)', () => {
  const root = sandbox();
  const cfg = structuredClone(example);
  delete cfg.repos.api.test_command;
  fs.writeFileSync(path.join(root, 'argus.config.json'), JSON.stringify(cfg));
  const data = path.join(root, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ title: 't', branch: 'b', summary: 's', acceptance_criteria: ['a'], out_of_scope: ['b'], repo_key: 'api' }));
  const r = run(root, 'render', 'worker-prompt', '--data', data, '--story', '12');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /test_command/);
});

test('report-check and plan wire through the CLI', () => {
  const root = sandbox();
  const plan = path.join(root, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ stories: [{ id: '1', repo: 'db' }, { id: '2', repo: 'api', depends_on: ['1'] }] }));
  const p = JSON.parse(run(root, 'plan', plan).stdout);
  assert.deepEqual(p.waves.map((w) => w.stories), [['1'], ['2']]);
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, '{}');
  assert.notEqual(run(root, 'report-check', bad).status, 0);
});

test('plan --launch prints a manual-mode launch plan', () => {
  const root = sandbox();
  const plan = path.join(root, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ stories: [{ id: '1' }, { id: '2' }, { id: '3', depends_on: ['1'] }] }));
  const r = run(root, 'plan', plan, '--launch');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Wave 1: start these 2 sessions together/);
  assert.match(r.stdout, /story 3: new worker session, prompt file orchestration\/3\/prompt.md/);
});

test('derivedFields uses repo paths from config', () => {
  const root = sandbox();
  const cfg = loadConfig({ path: path.join(root, 'argus.config.json'), via: 't' });
  const f = derivedFields(cfg, '9', { repo_key: 'web', tags: [] });
  assert.equal(f.test_command, 'npm test');
  assert.deepEqual(f.rules, ['docs/rules']);
  assert.equal(f.issue_url, 'https://github.com/acme-co/acme-web/issues/9');
});
