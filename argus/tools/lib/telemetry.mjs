// Builds final-report telemetry fields from machine sources. Every field is machine-sourced,
// or null with a reason. Nothing here is estimated or guessed.
import { parseClaudeTranscript } from './claude-log.mjs';
import { parseCopilotEvents } from './copilot-log.mjs';
import { verifyPricing } from './pricing.mjs';
import { TELEMETRY_KEYS } from './report.mjs';

export const machine = (value, tool, note) => ({ value, source: 'machine', tool, ...(note ? { note } : {}) });
export const unknown = (reason) => ({ value: null, reason });

/** Parse `git diff --numstat` output. Binary files count as changed files with unknown line counts. */
export function parseNumstat(text) {
  let files = 0, added = 0, removed = 0, binary = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [a, r] = line.split('\t');
    files++;
    if (a === '-' || r === '-') { binary++; continue; }
    added += Number(a);
    removed += Number(r);
  }
  return { files, added, removed, binary };
}

/** Parse a junit.xml. Uses the root <testsuites> counts when present, else sums top-level <testsuite> tags. */
export function parseJunit(xml) {
  const attr = (tag, name) => { const m = new RegExp(`\\b${name}="(\\d+)"`).exec(tag); return m ? Number(m[1]) : 0; };
  const root = /<testsuites\b[^>]*>/.exec(xml);
  let tests, failures, errors, skipped;
  if (root && /\btests="/.test(root[0])) {
    ({ tests, failures, errors, skipped } = Object.fromEntries(['tests', 'failures', 'errors', 'skipped'].map((k) => [k, attr(root[0], k)])));
  } else {
    tests = failures = errors = skipped = 0;
    for (const tag of xml.match(/<testsuite\b[^>]*>/g) ?? []) {
      tests += attr(tag, 'tests'); failures += attr(tag, 'failures'); errors += attr(tag, 'errors'); skipped += attr(tag, 'skipped');
    }
  }
  const failed = failures + errors;
  return { tests, failed, skipped, passed: Math.max(0, tests - failed - skipped) };
}

/**
 * Telemetry from a Claude Code transcript plus optional numstat and junit text.
 * Returns { telemetry, extras }. `extras` holds diagnostics that are not contract fields.
 */
export function buildClaudeTelemetry({ transcript, pricing, numstat, junit }) {
  const p = parseClaudeTranscript(transcript, { pricing });
  const cs = p.cost_state;
  const T = {};
  const tool = 'claude-code transcript';
  const csTool = 'claude-code cost-state';

  T.model = p.models.length ? machine(p.models, tool) : unknown('no assistant messages with token usage in transcript');
  T.reasoning_effort = p.efforts.length ? machine(p.efforts, tool) : unknown('no effort value recorded in transcript');
  T.duration_seconds = cs?.total_duration_ms != null ? machine(cs.total_duration_ms / 1000, csTool) : unknown('no cost-state row with totalDuration in transcript');

  const tokenKeys = { tokens_input: 'input', tokens_output: 'output', tokens_cache_read: 'cache_read' };
  const tr = Object.values(p.tokens_by_model).reduce((a, t) => { for (const k of Object.keys(a)) a[k] += t[k]; return a; }, { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, thinking: 0 });
  const src = cs ? { v: cs.tokens, tool: csTool, note: null } : p.messages ? { v: tr, tool, note: 'transcript rows only, not reconciled against a cost-state row' } : null;
  for (const [field, k] of Object.entries(tokenKeys)) T[field] = src ? machine(src.v[k], src.tool, src.note) : unknown('no token usage in transcript');
  T.tokens_cache_write = src ? machine(src.v.cache_write_5m + src.v.cache_write_1h, src.tool, src.note) : unknown('no token usage in transcript');

  const tail = p.after_last_cost_state;
  const tailNote = tail?.messages ? `${tail.messages} assistant message(s) came after the last cost-state snapshot and are not included; see extras.after_last_cost_state` : undefined;
  if (tailNote) for (const k of ['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write']) if (T[k].source === 'machine' && T[k].tool === csTool) T[k].note = tailNote;
  if (cs && cs.total_cost_usd !== null && !cs.has_unknown_model_cost) {
    T.cost = machine(cs.total_cost_usd, csTool, tailNote);
    T.cost_unit = machine('usd_api_equivalent', csTool);
  } else {
    const why = cs?.has_unknown_model_cost ? 'Claude Code reports a model with unknown cost' : 'no cost-state row in transcript; see extras.transcript_cost for a lower-bound estimate';
    T.cost = unknown(why);
    T.cost_unit = unknown(why);
  }

  if (numstat !== undefined) {
    const s = parseNumstat(numstat);
    T.files_changed = machine(s.files, 'git diff --numstat');
    T.lines_added = machine(s.added, 'git diff --numstat', s.binary ? `${s.binary} binary file(s) have no line counts` : undefined);
    T.lines_removed = machine(s.removed, 'git diff --numstat', s.binary ? `${s.binary} binary file(s) have no line counts` : undefined);
  }
  if (junit !== undefined) {
    const j = parseJunit(junit);
    T.tests_passed = machine(j.passed, 'junit.xml');
    T.tests_failed = machine(j.failed, 'junit.xml');
  }
  for (const k of TELEMETRY_KEYS) {
    if (T[k]) continue;
    T[k] = unknown(k.startsWith('tests_') ? 'no junit.xml supplied' : k.startsWith('lines_') || k === 'files_changed' ? 'no git numstat supplied' : 'not observable from this log');
  }

  return {
    telemetry: T,
    extras: {
      transcript_cost: p.transcript_cost,
      reconciliation: p.reconciliation,
      after_last_cost_state: p.after_last_cost_state,
      pricing_verification: cs && pricing ? verifyPricing(pricing, cs.model_usage) : null,
      models_zero_usage: p.models_zero_usage,
      bad_lines: p.bad_lines,
    },
  };
}

const COPILOT_NO_LOG = 'no Copilot events.jsonl supplied (--log). Copilot cost is reported in AIU and is never converted to dollars.';

/**
 * Telemetry from a Copilot CLI events.jsonl. With no log, every field is null with a reason.
 * Cost unit is "aiu" (nano-AIU / 1e9, as reported). Never converted to dollars.
 */
export function buildCopilotTelemetry({ log, numstat, junit } = {}) {
  const T = {};
  if (log === undefined) {
    for (const k of TELEMETRY_KEYS) T[k] = unknown(COPILOT_NO_LOG);
    return { telemetry: T, extras: { parser: 'copilot', implemented: true, log_supplied: false } };
  }
  const p = parseCopilotEvents(log);
  const tool = 'copilot events.jsonl';
  const src = p.totals;
  const notes = [];
  if (!src) notes.push('no shutdown or checkpoint snapshot; summed usage_record events');
  else if (src.source === 'session.usage_checkpoint') notes.push('session has not shut down; values are from the last usage checkpoint');
  if (p.reconciliation && !p.reconciliation.reconciled) notes.push('usage records do not reconcile with the snapshot; snapshot reported');
  if (p.records.rate_mismatch_calls) notes.push(`${p.records.rate_mismatch_calls} call(s) where embedded rates do not reproduce the reported AIU`);
  const note = notes.length ? notes.join('; ') : undefined;
  const tok = src?.tokens ?? p.records.tokens;
  const nano = src ? src.nano_aiu : p.records.nano_aiu;
  const ts = src?.source ?? 'usage_record sum';
  const have = p.records.calls > 0 || Boolean(src);

  T.model = p.models.length ? machine(p.models, tool) : unknown('no usage records in log');
  T.reasoning_effort = p.efforts.length ? machine(p.efforts, tool) : unknown('no reasoning effort recorded in log');
  const end = p.ended_at ?? p.last_event_at;
  const wall = p.started_at && end ? (Date.parse(end) - Date.parse(p.started_at)) / 1000 : null;
  T.duration_seconds = wall !== null && !Number.isNaN(wall)
    ? machine(wall, tool, p.ended_at ? 'wall clock from session.start to session.shutdown' : 'wall clock from session.start to the last event; session has not shut down')
    : unknown('no session start time or end in log');
  for (const [field, k] of [['tokens_input', 'input'], ['tokens_output', 'output'], ['tokens_cache_read', 'cache_read'], ['tokens_cache_write', 'cache_write']]) {
    T[field] = have ? machine(tok[k], `${tool} ${ts}`, note) : unknown('no token usage in log');
  }
  T.cost = have ? machine(nano / 1e9, `${tool} ${ts}`, note) : unknown('no usage in log');
  T.cost_unit = have ? machine('aiu', `${tool} ${ts}`) : unknown('no usage in log');

  if (numstat !== undefined) {
    const s = parseNumstat(numstat);
    T.files_changed = machine(s.files, 'git diff --numstat');
    T.lines_added = machine(s.added, 'git diff --numstat', s.binary ? `${s.binary} binary file(s) have no line counts` : undefined);
    T.lines_removed = machine(s.removed, 'git diff --numstat', s.binary ? `${s.binary} binary file(s) have no line counts` : undefined);
  }
  if (junit !== undefined) {
    const j = parseJunit(junit);
    T.tests_passed = machine(j.passed, 'junit.xml');
    T.tests_failed = machine(j.failed, 'junit.xml');
  }
  for (const k of TELEMETRY_KEYS) {
    if (T[k]) continue;
    T[k] = unknown(k.startsWith('tests_') ? 'no junit.xml supplied' : 'no git numstat supplied');
  }
  return {
    telemetry: T,
    extras: {
      parser: 'copilot',
      implemented: true,
      log_supplied: true,
      premium_requests: src?.premium_requests ?? p.records.premium,
      api_duration_ms: src?.api_duration_ms ?? null,
      credits_status: src?.credits_status ?? null,
      session_code_changes: src?.code_changes ?? null,
      reconciliation: p.reconciliation,
      records: p.records,
      by_model: p.by_model,
      fusion_events_ignored: p.fusion_events_ignored,
      shutdown_type: p.shutdown_type,
      bad_lines: p.bad_lines,
    },
  };
}
