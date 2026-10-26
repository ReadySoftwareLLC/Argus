// Claude Code transcript parser (~/.claude/projects/<project>/<session>.jsonl).
// Format facts below were observed in a real transcript, not assumed:
// - assistant rows repeat once per content block with the same message.id and identical usage,
//   and some rows carry null or all-zero usage. Dedupe by message.id, keep the row with the most output tokens.
// - cache writes split into usage.cache_creation.ephemeral_5m/1h_input_tokens (different prices).
// - `cost-state` rows hold Claude Code's own cumulative session totals and per-model usage. They include
//   token counts that the transcript rows alone do not sum to, so both views are reported.
import { priceMessage } from './pricing.mjs';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ZERO = () => ({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, thinking: 0 });

export function parseJsonl(text) {
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad };
}

/** Normalize one usage object. `split_known` is false when cache writes cannot be assigned to a tier. */
export function normalizeUsage(u) {
  const cc = u.cache_creation;
  const total = n(u.cache_creation_input_tokens);
  const hasSplit = cc && (typeof cc.ephemeral_5m_input_tokens === 'number' || typeof cc.ephemeral_1h_input_tokens === 'number');
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cache_read: n(u.cache_read_input_tokens),
    cache_write_5m: hasSplit ? n(cc.ephemeral_5m_input_tokens) : 0,
    cache_write_1h: hasSplit ? n(cc.ephemeral_1h_input_tokens) : 0,
    thinking: n(u.output_tokens_details?.thinking_tokens),
    split_known: hasSplit || total === 0,
  };
}

const isZero = (u) => !(u.input || u.output || u.cache_read || u.cache_write_5m || u.cache_write_1h);

export function parseClaudeTranscript(text, { pricing } = {}) {
  const { rows, bad } = parseJsonl(text);
  const best = new Map(); // message.id -> { model, ts, usage, geo, speed }
  const efforts = new Set();
  let sessionId = null;
  let firstTs = null;
  let lastTs = null;
  let costState = null;
  let costStateIdx = -1;
  for (const [idx, r] of rows.entries()) {
    sessionId ??= r.sessionId ?? null;
    if (r.timestamp) { firstTs ??= r.timestamp; lastTs = r.timestamp; }
    if (r.effort) efforts.add(r.effort);
    if (r.type === 'cost-state') { costState = r; costStateIdx = idx; }
    if (r.type !== 'assistant' || !r.message?.usage || !r.message.id) continue;
    const usage = normalizeUsage(r.message.usage);
    const cur = best.get(r.message.id);
    if (!cur || usage.output >= cur.usage.output) {
      best.set(r.message.id, { idx, model: r.message.model, ts: r.timestamp, usage, geo: r.message.usage.inference_geo ?? null, speed: r.message.usage.speed ?? null });
    }
  }

  const byModel = {};
  const zeroModels = new Set();
  let computed = 0;
  let unknown = 0;
  const reasons = new Set();
  let messages = 0;
  for (const m of best.values()) {
    if (isZero(m.usage)) { zeroModels.add(m.model); continue; }
    messages++;
    const t = (byModel[m.model] ??= ZERO());
    for (const k of Object.keys(t)) t[k] += m.usage[k];
    if (!pricing) continue;
    if (!m.usage.split_known) { unknown++; reasons.add('cache write tier unknown'); continue; }
    const p = priceMessage(pricing, m.usage, { model: m.model, ts: m.ts, geo: m.geo, speed: m.speed });
    if (p.usd === null) { unknown++; reasons.add(p.reason); } else computed += p.usd;
  }
  for (const id of Object.keys(byModel)) zeroModels.delete(id);

  // cost-state is a periodic snapshot: rows written after it are not in its totals.
  const prefix = ZERO();
  const tail = { messages: 0, tokens: ZERO(), usd_known: 0, messages_unpriced: 0 };
  for (const m of best.values()) {
    if (isZero(m.usage) || costStateIdx < 0) continue;
    if (m.idx < costStateIdx) { for (const k of Object.keys(prefix)) prefix[k] += m.usage[k]; continue; }
    tail.messages++;
    for (const k of Object.keys(tail.tokens)) tail.tokens[k] += m.usage[k];
    if (!pricing) continue;
    const p = m.usage.split_known ? priceMessage(pricing, m.usage, { model: m.model, ts: m.ts, geo: m.geo, speed: m.speed }) : { usd: null };
    if (p.usd === null) tail.messages_unpriced++; else tail.usd_known += p.usd;
  }

  const result = {
    session_id: sessionId,
    first_timestamp: firstTs,
    last_timestamp: lastTs,
    bad_lines: bad,
    messages,
    models: Object.keys(byModel),
    models_zero_usage: [...zeroModels],
    efforts: [...efforts],
    tokens_by_model: byModel,
    transcript_cost: pricing ? { usd_known: computed, messages_unpriced: unknown, reasons: [...reasons] } : null,
    cost_state: null,
    reconciliation: null,
    after_last_cost_state: null,
  };

  if (costState) {
    const mu = costState.modelUsage ?? {};
    const sum = ZERO();
    for (const u of Object.values(mu)) {
      sum.input += n(u.inputTokens);
      sum.output += n(u.outputTokens);
      sum.cache_read += n(u.cacheReadInputTokens);
      sum.cache_write_5m += n(u.cacheCreationEphemeral5mInputTokens);
      sum.cache_write_1h += n(u.cacheCreationEphemeral1hInputTokens);
      sum.thinking += n(u.thinkingTokens);
    }
    result.cost_state = {
      total_cost_usd: typeof costState.totalCostUSD === 'number' ? costState.totalCostUSD : null,
      has_unknown_model_cost: Boolean(costState.hasUnknownModelCost),
      total_duration_ms: typeof costState.totalDuration === 'number' ? costState.totalDuration : null,
      model_usage: mu,
      tokens: sum,
    };
    // Compare only rows that precede the snapshot, so a later tail does not look like a gap.
    result.reconciliation = Object.fromEntries(['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'].map((k) => [k, { transcript_before_snapshot: prefix[k], cost_state: sum[k], missing_from_transcript: sum[k] - prefix[k] }]));
    result.after_last_cost_state = tail;
  }
  return result;
}
