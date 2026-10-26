import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendEvent, budgetCheck, eventFromReport, latestPerIssue, queryIndex, readEvents, rebuildIndex, rollup, templateFromPrompt } from '../argus/tools/lib/ledger.mjs';
import { TELEMETRY_KEYS } from '../argus/tools/lib/report.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ledger-'));

function report(issue, { cost = null, unit = null, outcome = 'done', verdict = 'pass' } = {}) {
  const telemetry = Object.fromEntries(TELEMETRY_KEYS.map((k) => [k, { value: null, reason: 'n/a' }]));
  if (cost !== null) {
    telemetry.cost = { value: cost, source: 'machine', tool: 't' };
    telemetry.cost_unit = { value: unit, source: 'machine', tool: 't' };
  }
  telemetry.tokens_output = { value: 100, source: 'machine', tool: 't' };
  return {
    contract_version: 1, issue, outcome,
    pr: outcome === 'done' ? { url: 'https://x/pull/1', number: 1 } : null, pr_reason: 'blocked',
    blocked_reason: outcome === 'done' ? undefined : 'blocked',
    criteria: [{ criterion: 'c', status: 'met', evidence: 'e' }],
    review: { dispatched: true, verdict, path: 'r.md' }, telemetry, tangents: ['t1'],
  };
}
const tpl = (v) => ({ name: 'worker-prompt', version: v });

test('template marker is read from the prompt, or null with a reason', () => {
  assert.deepEqual(templateFromPrompt('<!-- argus-template: worker-prompt v3 -->\n# x'), { name: 'worker-prompt', version: 3 });
  assert.match(templateFromPrompt('# no marker').reason, /no argus-template marker/);
  assert.match(templateFromPrompt(null).reason, /not found/);
});

test('append is idempotent per (issue, report) and keeps different reports', () => {
  const file = path.join(tmp(), 'ledger.jsonl');
  const e1 = eventFromReport(report('1', { cost: 1, unit: 'usd_api_equivalent' }), { template: tpl(1) });
  assert.equal(appendEvent(file, e1).appended, true);
  assert.equal(appendEvent(file, e1).appended, false);
  const e2 = eventFromReport(report('1', { cost: 2, unit: 'usd_api_equivalent' }), { template: tpl(1), ts: '2099-01-01T00:00:00Z' });
  assert.equal(appendEvent(file, e2).appended, true);
  assert.equal(readEvents(file).length, 2);
});

test('corrupt ledger line is an error, not silently skipped', () => {
  const file = path.join(tmp(), 'l.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{broken\n');
  assert.throws(() => readEvents(file), /Corrupt ledger line 2/);
});

test('latest report per issue supersedes earlier ones', () => {
  const a = eventFromReport(report('1', { cost: 1, unit: 'usd_api_equivalent' }), { ts: '2026-01-01T00:00:00Z' });
  const b = eventFromReport(report('1', { cost: 5, unit: 'usd_api_equivalent' }), { ts: '2026-01-02T00:00:00Z' });
  const l = latestPerIssue([b, a]);
  assert.equal(l.length, 1);
  assert.equal(l[0].telemetry.cost.value, 5);
});

test('rollup never counts unknown cost as zero and keeps units apart', () => {
  const events = [
    eventFromReport(report('1', { cost: 1.5, unit: 'usd_api_equivalent' }), { template: tpl(1) }),
    eventFromReport(report('2', { cost: 10, unit: 'credits' }), { template: tpl(1) }),
    eventFromReport(report('3'), { template: tpl(2) }),
    eventFromReport(report('4', { outcome: 'blocked', verdict: 'changes_requested' }), { template: { name: null, version: null, reason: 'x' } }),
  ];
  const r = rollup(events);
  assert.equal(r.cost.usd_api_equivalent, 1.5);
  assert.equal(r.cost.credits, 10);
  assert.deepEqual(r.unknown_cost_stories.map((u) => u.issue), ['3', '4']);
  assert.equal(r.by_template['worker-prompt@v1'].stories, 2);
  assert.equal(r.by_template['worker-prompt@v2'].unknown_cost_stories, 1);
  assert.equal(r.by_template['unknown-template'].review_changes_requested, 1);
  assert.deepEqual(r.outcomes, { done: 3, blocked: 1 });
});

test('a noted cost is a lower bound: counted, but flagged as partial and the budget is not complete', () => {
  const r0 = report('9', { cost: 3, unit: 'usd_api_equivalent' });
  r0.telemetry.cost.note = '2 assistant message(s) came after the last cost-state snapshot';
  const roll = rollup([eventFromReport(r0, { template: tpl(1) })]);
  assert.equal(roll.cost.usd_api_equivalent, 3);
  assert.deepEqual(roll.partial_cost_stories.map((p) => p.issue), ['9']);
  const b = budgetCheck(roll, 10);
  assert.equal(b.complete, false);
  assert.equal(b.partial_cost_stories, 1);
  assert.match(b.message, /lower bounds/);
});

test('budget guard: over, under, unknown and unset', () => {
  const mk = (usd, unknown) => ({ cost: { usd_api_equivalent: usd }, unknown_cost_stories: Array.from({ length: unknown }, () => ({})), partial_cost_stories: [] });
  assert.equal(budgetCheck(mk(10, 0), 10).over_budget, true);
  assert.equal(budgetCheck(mk(9.99, 0), 10).over_budget, false);
  const u = budgetCheck(mk(1, 2), 10);
  assert.equal(u.complete, false);
  assert.match(u.message, /unknown or lower bounds/);
  assert.equal(budgetCheck(mk(999, 0), null).over_budget, false);
});

test('SQLite index is rebuildable from the ledger and queryable read-only', async () => {
  const dir = tmp();
  const events = [
    eventFromReport(report('1', { cost: 1.5, unit: 'usd_api_equivalent' }), { template: tpl(1), ts: '2026-01-01T00:00:00Z' }),
    eventFromReport(report('1', { cost: 2.5, unit: 'usd_api_equivalent' }), { template: tpl(1), ts: '2026-01-02T00:00:00Z' }),
    eventFromReport(report('2'), { template: tpl(2) }),
  ];
  const db = path.join(dir, '.argus', 'index.sqlite');
  assert.equal((await rebuildIndex(events, db)).events, 3);
  assert.equal((await rebuildIndex(events, db)).events, 3); // rebuild is safe to repeat
  const latest = await queryIndex(db, 'SELECT issue, cost FROM story_latest ORDER BY issue');
  assert.deepEqual(latest.map((r) => ({ ...r })), [{ issue: '1', cost: 2.5 }, { issue: '2', cost: null }]);
  const byTpl = await queryIndex(db, 'SELECT template_version v, COUNT(*) n FROM events GROUP BY v ORDER BY v');
  assert.deepEqual(byTpl.map((r) => ({ ...r })), [{ v: 1, n: 2 }, { v: 2, n: 1 }]);
  await assert.rejects(() => queryIndex(db, 'DELETE FROM events'), /Only a single SELECT/);
  await assert.rejects(() => queryIndex(db, 'SELECT 1; DROP TABLE events'), /Only a single SELECT/);
});

// ---- CLI wiring
const CLI = new URL('../argus/tools/argus.mjs', import.meta.url).pathname;
const example = JSON.parse(fs.readFileSync(new URL('../argus/argus.config.example.json', import.meta.url), 'utf8'));
function sandbox(cfgOver = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'argus.config.json'), JSON.stringify({ ...example, ...cfgOver }));
  return root;
}
const run = (root, ...args) => spawnSync('node', [CLI, ...args, '--config', path.join(root, 'argus.config.json')], { encoding: 'utf8', cwd: root });

test('CLI: telemetry --merge fills the report, ledger add records it with the prompt template, costs sums it', () => {
  const root = sandbox({ limits: { epic_budget_usd: 2 } });
  const story = path.join(root, 'orchestration/7');
  fs.mkdirSync(story, { recursive: true });
  fs.writeFileSync(path.join(story, 'prompt.md'), '<!-- argus-template: worker-prompt v1 -->\n# x\n');
  const log = path.join(root, 'session.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-26T22:00:00Z', effort: 'medium', message: { id: 'm', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 } } })}\n${JSON.stringify({ type: 'cost-state', totalCostUSD: 2.5, totalDuration: 1000, hasUnknownModelCost: false, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, costUSD: 2.5 } } })}\n`);
  const rep = path.join(story, 'final-report.json');
  const base = report('7');
  delete base.telemetry;
  fs.writeFileSync(rep, JSON.stringify(base));

  const t = run(root, 'telemetry', '--claude', log, '--merge', rep);
  assert.equal(t.status, 0, t.stderr);
  assert.equal(run(root, 'report-check', rep).status, 0, 'merged report must satisfy the contract');

  const add = JSON.parse(run(root, 'ledger', 'add', rep).stdout);
  assert.equal(add.appended, true);
  assert.equal(JSON.parse(run(root, 'ledger', 'add', rep).stdout).appended, false);
  const ev = readEvents(path.join(root, 'orchestration/ledger.jsonl'))[0];
  assert.equal(ev.template_name, 'worker-prompt');
  assert.equal(ev.template_version, 1);

  const costs = run(root, 'costs');
  assert.equal(costs.status, 1, 'known cost 2.5 is over the budget of 2');
  assert.equal(JSON.parse(costs.stdout).budget.over_budget, true);
  assert.equal(run(root, 'index').status, 0);
  const q = JSON.parse(run(root, 'index', '--sql', 'SELECT cost FROM story_latest').stdout);
  assert.equal(q[0].cost, 2.5);
});

test('CLI: ledger add rejects a report that violates the contract', () => {
  const root = sandbox();
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, '{}');
  const r = run(root, 'ledger', 'add', bad);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /fails the contract/);
});

test('CLI: pricing check passes for a fresh file and fails for a stale one', () => {
  const root = tmp();
  const base = JSON.parse(fs.readFileSync(new URL('../argus/pricing/anthropic.json', import.meta.url), 'utf8'));
  const stale = path.join(root, 'p.json');
  fs.writeFileSync(stale, JSON.stringify({ ...base, retrieved: '2020-01-01' }));
  const r = spawnSync('node', [CLI, 'pricing', '--file', stale], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).stale, true);
  const fresh = path.join(root, 'f.json');
  fs.writeFileSync(fresh, JSON.stringify({ ...base, retrieved: new Date().toISOString().slice(0, 10) }));
  assert.equal(spawnSync('node', [CLI, 'pricing', '--file', fresh], { encoding: 'utf8' }).status, 0);
});

test('CLI: telemetry --host copilot returns all-null telemetry', () => {
  const r = spawnSync('node', [CLI, 'telemetry', '--host', 'copilot'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).extras.implemented, false);
});
