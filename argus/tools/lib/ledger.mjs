// Append-only JSONL ledger (source of truth, committed) + rebuildable SQLite index (derived, gitignored).
// Unknown is never zero: cost rollups sum known values and count unknown ones separately.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ArgusError } from './util.mjs';

export const LEDGER_VERSION = 1;
const MARKER = /<!--\s*argus-template:\s*([\w-]+)\s+v(\d+)\s*-->/;

export const ledgerPath = (config) => path.join(config._orchestration_abs, 'ledger.jsonl');
export const indexPath = (config) => path.join(config._orchestration_abs, '.argus', 'index.sqlite');

/** Template name and version read from the generated prompt, or null with a reason. */
export function templateFromPrompt(promptText) {
  if (promptText == null) return { name: null, version: null, reason: 'prompt file not found' };
  const m = MARKER.exec(promptText);
  return m ? { name: m[1], version: Number(m[2]) } : { name: null, version: null, reason: 'no argus-template marker in prompt' };
}

export function eventFromReport(report, { template, ts = new Date().toISOString() } = {}) {
  const reportSha = crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0, 16);
  return {
    v: LEDGER_VERSION,
    type: 'story_finished',
    ts,
    issue: report.issue,
    outcome: report.outcome,
    review_verdict: report.review?.verdict ?? null,
    review_dispatched: report.review?.dispatched ?? null,
    pr_number: report.pr?.number ?? null,
    criteria_unmet: (report.criteria ?? []).filter((c) => c.status !== 'met').length,
    tangents: (report.tangents ?? []).length,
    template_name: template?.name ?? null,
    template_version: template?.version ?? null,
    template_reason: template?.reason ?? null,
    report_sha: reportSha,
    telemetry: report.telemetry,
  };
}

export function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new ArgusError(`Corrupt ledger line ${i + 1} in ${file}: ${e.message}`); }
  });
}

/** Append unless an identical (type, issue, report_sha) event exists. Returns { appended }. */
export function appendEvent(file, event) {
  const existing = readEvents(file);
  if (existing.some((e) => e.type === event.type && e.issue === event.issue && e.report_sha === event.report_sha)) return { appended: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  return { appended: true };
}

const val = (f) => (f && f.value !== null && f.value !== undefined ? f.value : null);

/** Latest story_finished per issue. */
export function latestPerIssue(events) {
  const latest = new Map();
  events.filter((e) => e.type === 'story_finished').forEach((e, i) => {
    const cur = latest.get(e.issue);
    if (!cur || e.ts > cur.e.ts || (e.ts === cur.e.ts && i > cur.i)) latest.set(e.issue, { e, i });
  });
  return [...latest.values()].map((x) => x.e);
}

export function rollup(events) {
  const stories = latestPerIssue(events);
  const out = { stories: stories.length, cost: { usd_api_equivalent: 0, aiu: 0, credits: 0 }, unknown_cost_stories: [], partial_cost_stories: [], by_template: {}, outcomes: {} };
  for (const s of stories) {
    out.outcomes[s.outcome] = (out.outcomes[s.outcome] ?? 0) + 1;
    const key = s.template_name ? `${s.template_name}@v${s.template_version}` : 'unknown-template';
    const t = (out.by_template[key] ??= { stories: 0, done: 0, review_changes_requested: 0, usd_api_equivalent: 0, unknown_cost_stories: 0 });
    t.stories++;
    if (s.outcome === 'done') t.done++;
    if (s.review_verdict === 'changes_requested') t.review_changes_requested++;
    const cost = val(s.telemetry?.cost);
    const unit = val(s.telemetry?.cost_unit);
    if (typeof cost === 'number' && unit && unit in out.cost) {
      out.cost[unit] += cost;
      if (unit === 'usd_api_equivalent') t.usd_api_equivalent += cost;
      // A noted cost is a lower bound (e.g. messages after the last snapshot). Keep it visible.
      if (s.telemetry.cost.note) out.partial_cost_stories.push({ issue: s.issue, note: s.telemetry.cost.note });
    } else {
      out.unknown_cost_stories.push({ issue: s.issue, reason: s.telemetry?.cost?.reason ?? 'cost missing from report' });
      t.unknown_cost_stories++;
    }
  }
  return out;
}

/** Budget guard. Unknown cost is reported, never treated as zero. */
export function budgetCheck(roll, limitUsd) {
  const known = roll.cost.usd_api_equivalent;
  const unknown = roll.unknown_cost_stories.length;
  const partial = roll.partial_cost_stories?.length ?? 0;
  return {
    limit_usd: limitUsd ?? null,
    known_cost_usd: known,
    unknown_cost_stories: unknown,
    partial_cost_stories: partial,
    complete: unknown === 0 && partial === 0,
    over_budget: limitUsd == null ? false : known >= limitUsd,
    message: limitUsd == null ? 'no budget set' : known >= limitUsd ? 'halt dispatch: known cost is at or over budget' : unknown || partial ? 'under budget on known cost, but some story costs are unknown or lower bounds' : 'under budget',
  };
}

/** Rebuild the derived SQLite index from the ledger. Needs Node with node:sqlite (22.13+). */
export async function rebuildIndex(events, dbFile) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { throw new ArgusError('node:sqlite is not available. Use Node 22.13 or later.'); }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.rmSync(dbFile, { force: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE events (
    seq INTEGER PRIMARY KEY, ts TEXT, type TEXT, issue TEXT, outcome TEXT, review_verdict TEXT,
    template_name TEXT, template_version INTEGER, cost REAL, cost_unit TEXT, cost_reason TEXT,
    tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
    duration_seconds REAL, json TEXT NOT NULL);
    CREATE INDEX events_issue ON events(issue);
    CREATE INDEX events_template ON events(template_name, template_version);`);
  const ins = db.prepare(`INSERT INTO events (ts,type,issue,outcome,review_verdict,template_name,template_version,cost,cost_unit,cost_reason,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write,duration_seconds,json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const e of events) {
    const t = e.telemetry ?? {};
    ins.run(e.ts ?? null, e.type ?? null, e.issue ?? null, e.outcome ?? null, e.review_verdict ?? null, e.template_name ?? null, e.template_version ?? null,
      val(t.cost), val(t.cost_unit), t.cost?.reason ?? null, val(t.tokens_input), val(t.tokens_output), val(t.tokens_cache_read), val(t.tokens_cache_write),
      val(t.duration_seconds), JSON.stringify(e));
  }
  db.exec('CREATE VIEW story_latest AS SELECT * FROM events e WHERE type = \'story_finished\' AND seq = (SELECT MAX(seq) FROM events x WHERE x.issue = e.issue AND x.type = e.type)');
  db.close();
  return { events: events.length, file: dbFile };
}

/** Read-only SELECT against the index. */
export async function queryIndex(dbFile, sql) {
  if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) throw new ArgusError('Only a single SELECT statement is allowed.');
  if (!fs.existsSync(dbFile)) throw new ArgusError(`Index not found: ${dbFile}. Run: argus index`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
