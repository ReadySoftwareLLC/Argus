import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../argus/tools/lib/config.mjs';
import { exportLedger, loadPrimary, readImports } from '../argus/tools/lib/export.mjs';
import { queryIndex } from '../argus/tools/lib/ledger.mjs';

const CLI = new URL('../argus/tools/argus.mjs', import.meta.url).pathname;
const example = JSON.parse(fs.readFileSync(new URL('../argus/argus.config.example.json', import.meta.url), 'utf8'));
const cli = (cwd, ...a) => spawnSync('node', [CLI, ...a], { encoding: 'utf8', cwd });

function solution(trackerRepo, name, extra = {}, events = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-exp-'));
  fs.mkdirSync(path.join(root, '.git'));
  const cfg = { ...example, product: { name }, tracker: { type: 'github', repo: trackerRepo }, repos: { web: { path: '.' } }, anchor: 'web', policies: undefined, limits: { epic_budget_usd: null }, ...extra };
  fs.writeFileSync(path.join(root, 'argus.config.json'), JSON.stringify(cfg));
  fs.mkdirSync(path.join(root, 'orchestration'), { recursive: true });
  if (events.length) fs.writeFileSync(path.join(root, 'orchestration', 'ledger.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}
const ev = (issue, cost, tpl = 1, ts = '2026-01-01T00:00:00Z') => ({ type: 'story_finished', issue, ts, outcome: 'done', template_name: 'worker-prompt', template_version: tpl, telemetry: { cost: { value: cost, source: 'machine', tool: 't' }, cost_unit: { value: 'usd_api_equivalent', source: 'machine', tool: 't' } } });
const cfgOf = (root) => loadConfig({ path: path.join(root, 'argus.config.json'), via: 't' });

test('export needs a primary, and the primary must be a different solution', () => {
  const a = solution('acme/a', 'A');
  assert.throws(() => loadPrimary(cfgOf(a)), /No "primary"/);
  const self = solution('acme/self', 'S', { primary: './argus.config.json' });
  assert.throws(() => loadPrimary(cfgOf(self)), /same config/);
  const p = solution('acme/same', 'P');
  const dup = solution('acme/same', 'D', { primary: path.join(p, 'argus.config.json') });
  assert.throws(() => loadPrimary(cfgOf(dup)), /same solution/);
});

test('exportLedger tags events with their origin, is idempotent, and leaves the primary ledger alone', () => {
  const primary = solution('acme/primary', 'Primary', {}, [ev('1', 1)]);
  const child = solution('acme/child', 'Child', { primary: path.join(primary, 'argus.config.json') }, [ev('1', 5), ev('2', 6)]);
  const before = fs.readFileSync(path.join(primary, 'orchestration/ledger.jsonl'), 'utf8');
  const p = loadPrimary(cfgOf(child));
  const first = exportLedger(cfgOf(child), p);
  const second = exportLedger(cfgOf(child), p);
  assert.equal(first.events, 2);
  assert.equal(fs.readFileSync(first.file, 'utf8'), fs.readFileSync(second.file, 'utf8'));
  assert.equal(path.basename(first.file), 'acme__child.jsonl');
  const imported = readImports(cfgOf(primary));
  assert.equal(imported.length, 2);
  assert.ok(imported.every((e) => e.solution === 'acme/child' && e.solution_name === 'Child'));
  assert.equal(fs.readFileSync(path.join(primary, 'orchestration/ledger.jsonl'), 'utf8'), before);
});

test('CLI: export, then index in the primary groups by solution without mixing issue numbers or budgets', async () => {
  const primary = solution('acme/primary', 'Primary', { limits: { epic_budget_usd: 3 } }, [ev('1', 1)]);
  const child = solution('acme/child', 'Child', { primary: path.join(primary, 'argus.config.json') }, [ev('1', 50, 2)]);
  const x = cli(child, 'export');
  assert.equal(x.status, 0, x.stderr);
  assert.equal(JSON.parse(x.stdout).events, 1);

  const idx = cli(primary, 'index');
  assert.equal(idx.status, 0, idx.stderr);
  assert.deepEqual([JSON.parse(idx.stdout).own, JSON.parse(idx.stdout).imported], [1, 1]);
  const rows = await queryIndex(path.join(primary, 'orchestration/.argus/index.sqlite'), 'SELECT solution, issue, cost FROM story_latest ORDER BY solution');
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ solution: 'acme/child', issue: '1', cost: 50 }, { solution: 'acme/primary', issue: '1', cost: 1 }]);

  // The child's $50 does not count against the primary's $3 budget.
  const costs = cli(primary, 'costs');
  assert.equal(costs.status, 0, costs.stdout);
  assert.equal(JSON.parse(costs.stdout).budget.known_cost_usd, 1);

  const noImp = cli(primary, 'index', '--no-imports');
  assert.equal(JSON.parse(noImp.stdout).imported, 0);
});
