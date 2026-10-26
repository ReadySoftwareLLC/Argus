// Builds final-report telemetry fields from machine sources. Every field is machine-sourced,
// or null with a reason. Nothing here is estimated or guessed.
import { parseClaudeTranscript } from './claude-log.mjs';
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

/** Copilot logs are not parsed yet: no verified sample of the format exists. Every field is null with that reason. */
export function buildCopilotTelemetry() {
  const reason = 'Copilot log parser is not implemented: no verified sample of the log format. Costs there are credits, not tokens, and are never converted to dollars.';
  return { telemetry: Object.fromEntries(TELEMETRY_KEYS.map((k) => [k, unknown(reason)])), extras: { parser: 'copilot', implemented: false } };
}
