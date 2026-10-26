// GitHub Copilot CLI session log parser (~/.copilot/session-state/<session-id>/events.jsonl).
// Format facts below were observed in a real session log, not assumed:
// - `session.usage_record` is one event per API call with token counts, a per-call `totalNanoAiu`, and
//   `copilotUsage.tokenDetails[]` carrying its own rate (`costPerBatch` nano-AIU per `batchSize` tokens).
//   Copilot embeds its rates, so no pricing file is needed and the cost can be self-checked.
// - `tokenDetails` token counts are billed counts: `input` is UNCACHED input, like Claude's input_tokens.
//   The record's `inputTokens` field also includes cache reads and writes.
// - `session.shutdown` (and periodic `session.usage_checkpoint`) carry an `accountingSnapshot` of session totals.
// - `session.fusion_*` events repeat usage that is already in the usage records. They are NOT summed.
// - Per-call `cost` is a premium-request multiplier. It counted toward the session's premium total only for
//   `initiator: "user"` calls (observed in one session; agent-initiated calls carried the same multiplier but were not counted).
// - The unit is AIU (nano-AIU / 1e9). It is never converted to dollars here.
import { parseJsonl } from './claude-log.mjs';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const TYPES = ['input', 'cache_read', 'cache_write', 'output'];
const ZERO = () => ({ input: 0, cache_read: 0, cache_write: 0, output: 0 });

/** Sum tokenDetails by type. Returns { tokens, nano_aiu_from_rates, complete }. */
export function tokensFromDetails(details) {
  const tokens = ZERO();
  let nano = 0;
  let seen = 0;
  for (const d of details ?? []) {
    if (!TYPES.includes(d.tokenType)) continue;
    seen++;
    tokens[d.tokenType] += n(d.tokenCount);
    nano += (n(d.tokenCount) * n(d.costPerBatch)) / (n(d.batchSize) || 1);
  }
  return { tokens, nano_aiu_from_rates: nano, complete: seen === TYPES.length };
}

export function parseCopilotEvents(text) {
  const { rows, bad } = parseJsonl(text);
  let sessionId = null;
  let startedAt = null;
  let shutdown = null;
  let checkpoint = null;
  let lastTs = null;
  const records = new Map(); // `${sourceSessionId}:${sequence}` -> record (first wins)
  const unkeyed = [];
  let fusionEventsIgnored = 0;

  for (const r of rows) {
    if (r.timestamp) lastTs = r.timestamp;
    const d = r.data ?? {};
    if (r.type === 'session.start') { sessionId = d.sessionId ?? null; startedAt = d.startTime ?? r.timestamp ?? null; }
    else if (r.type === 'session.shutdown') shutdown = { ts: r.timestamp, data: d };
    else if (r.type === 'session.usage_checkpoint') checkpoint = { ts: r.timestamp, data: d };
    else if (r.type?.startsWith('session.fusion') || r.type === 'assistant.fusion_phase_completed') fusionEventsIgnored++;
    else if (r.type === 'session.usage_record' && d.usage) {
      const u = d.usage;
      const seq = u.accounting?.sequence;
      const key = seq !== undefined ? `${u.accounting.sourceSessionId ?? sessionId}:${seq}` : null;
      const rec = { ts: r.timestamp, seq: seq ?? null, model: u.model ?? null, effort: u.reasoningEffort ?? null, initiator: u.initiator ?? null,
        premium_cost: typeof u.cost === 'number' ? u.cost : null, nano_aiu: n(u.copilotUsage?.totalNanoAiu),
        has_nano: typeof u.copilotUsage?.totalNanoAiu === 'number', duration_ms: n(u.duration),
        details: tokensFromDetails(u.copilotUsage?.tokenDetails) };
      if (key === null) unkeyed.push(rec);
      else if (!records.has(key)) records.set(key, rec);
    }
  }

  const recs = [...records.values(), ...unkeyed];
  const sum = { tokens: ZERO(), nano_aiu: 0, premium: 0, calls: recs.length, incomplete_calls: 0, rate_mismatch_calls: 0 };
  const models = new Set();
  const efforts = new Set();
  const byModel = {};
  for (const r of recs) {
    if (r.model) models.add(r.model);
    if (r.effort) efforts.add(r.effort);
    for (const t of TYPES) sum.tokens[t] += r.details.tokens[t];
    sum.nano_aiu += r.nano_aiu;
    // Observed: `cost` is a premium-request multiplier charged only on user-initiated calls. In the sample,
    // summing agent-initiated calls too gave 31 against the snapshot's 16. The snapshot stays authoritative.
    if (r.initiator === 'user') sum.premium += r.premium_cost ?? 0;
    if (!r.details.complete || !r.has_nano) sum.incomplete_calls++;
    // Self-check: Copilot's own embedded rates must reproduce Copilot's own per-call total.
    else if (Math.abs(r.details.nano_aiu_from_rates - r.nano_aiu) > 1) sum.rate_mismatch_calls++;
    const m = (byModel[r.model ?? 'unknown'] ??= { calls: 0, nano_aiu: 0, tokens: ZERO() });
    m.calls++; m.nano_aiu += r.nano_aiu;
    for (const t of TYPES) m.tokens[t] += r.details.tokens[t];
  }

  // Authoritative totals: shutdown snapshot, else last checkpoint snapshot, else the summed records.
  const snapSource = shutdown ? 'session.shutdown' : checkpoint ? 'session.usage_checkpoint' : null;
  const snap = (shutdown ?? checkpoint)?.data?.accountingSnapshot ?? null;
  let totals = null;
  let reconciliation = null;
  if (snap) {
    const td = snap.tokenDetails ?? {};
    totals = {
      source: snapSource,
      tokens: { input: n(td.input?.tokenCount), cache_read: n(td.cache_read?.tokenCount), cache_write: n(td.cache_write?.tokenCount), output: n(td.output?.tokenCount) },
      nano_aiu: n(snap.totalNanoAiu),
      premium_requests: typeof snap.totalPremiumRequestCost === 'number' ? snap.totalPremiumRequestCost : null,
      api_duration_ms: typeof snap.totalApiDurationMs === 'number' ? snap.totalApiDurationMs : null,
      credits_status: snap.aiCreditsStatus ?? null,
      code_changes: snap.codeChanges ?? null,
    };
    reconciliation = {
      nano_aiu: { records: sum.nano_aiu, snapshot: totals.nano_aiu, delta: totals.nano_aiu - sum.nano_aiu },
      ...Object.fromEntries(TYPES.map((t) => [t, { records: sum.tokens[t], snapshot: totals.tokens[t], delta: totals.tokens[t] - sum.tokens[t] }])),
    };
    reconciliation.reconciled = Object.values(reconciliation).every((x) => typeof x !== 'object' || Math.abs(x.delta) <= (x === reconciliation.nano_aiu ? 1 : 0));
  }

  const ended = shutdown?.ts ?? null;
  return {
    session_id: sessionId,
    started_at: startedAt,
    ended_at: ended,
    last_event_at: lastTs,
    bad_lines: bad,
    models: [...models],
    efforts: [...efforts],
    by_model: byModel,
    records: sum,
    totals,
    reconciliation,
    shutdown_type: shutdown?.data?.shutdownType ?? null,
    fusion_events_ignored: fusionEventsIgnored,
  };
}
