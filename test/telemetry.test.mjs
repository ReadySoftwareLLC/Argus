import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPricing, priceMessage, verifyPricing, rateEntryAt, pricingAgeDays } from '../argus/tools/lib/pricing.mjs';
import { parseClaudeTranscript, normalizeUsage } from '../argus/tools/lib/claude-log.mjs';
import { buildClaudeTelemetry, buildCopilotTelemetry, parseNumstat, parseJunit } from '../argus/tools/lib/telemetry.mjs';
import { checkReport, TELEMETRY_KEYS } from '../argus/tools/lib/report.mjs';

const pricing = loadPricing(new URL('../argus/pricing/anthropic.json', import.meta.url).pathname);

// Token counts and cost below are real values taken from a Claude Code cost-state row (no message text).
const REAL_CS = {
  'claude-sonnet-5-5': {
    inputTokens: 12336, outputTokens: 65403, thinkingTokens: 6743, cacheReadInputTokens: 14104459, cacheCreationInputTokens: 204380,
    cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 204380, webSearchRequests: 0, costUSD: 2.9066679,
  },
};

const U = (over = {}) => ({
  input_tokens: 2, output_tokens: 260, cache_read_input_tokens: 172838, cache_creation_input_tokens: 32447,
  cache_creation: { ephemeral_1h_input_tokens: 32447, ephemeral_5m_input_tokens: 0 },
  output_tokens_details: { thinking_tokens: 117 }, inference_geo: 'global', speed: 'standard', ...over,
});
const asst = (id, ts, usage, model = 'claude-sonnet-5-5', block = 'text') => JSON.stringify({
  type: 'assistant', timestamp: ts, sessionId: 's1', effort: 'medium',
  message: { id, model, role: 'assistant', content: [{ type: block }], usage },
});

function transcript({ withCostState = true } = {}) {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-26T22:00:00.000Z', sessionId: 's1' }),
    // msg A: one API message streamed as three rows with identical usage
    asst('msg_A', '2026-10-26T22:00:01.000Z', U(), undefined, 'thinking'),
    asst('msg_A', '2026-10-26T22:00:01.100Z', U(), undefined, 'text'),
    asst('msg_A', '2026-10-26T22:00:01.200Z', U(), undefined, 'tool_use'),
    // msg B: placeholder row with zero usage first, final row second
    asst('msg_B', '2026-10-26T22:00:05.000Z', U({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null })),
    asst('msg_B', '2026-10-26T22:00:05.300Z', U({ input_tokens: 4, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })),
    // msg C: no usage at all
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-26T22:00:06.000Z', message: { id: 'msg_C', model: 'claude-sonnet-5-5', content: [] } }),
    // msg D: other model, all zero usage
    asst('msg_D', '2026-10-26T22:00:07.000Z', U({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), 'claude-sonnet-4-6'),
    'not json at all',
  ];
  if (withCostState) lines.push(JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 2.9066679, totalDuration: 1155971, hasUnknownModelCost: false, modelUsage: REAL_CS }));
  return `${lines.join('\n')}\n`;
}

test('pricing reproduces Claude Code reported cost exactly from real token counts', () => {
  const [r] = verifyPricing(pricing, REAL_CS);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.computed_usd - 2.9066679) < 1e-9, `computed ${r.computed_usd}`);
});

test('verifyPricing flags drift when rates are wrong', () => {
  const stale = structuredClone(pricing);
  stale.models['claude-sonnet-5-5'].rates[0].tiers[0].output = 15;
  assert.equal(verifyPricing(stale, REAL_CS)[0].ok, false);
});

test('verifyPricing reports unknowns instead of guessing', () => {
  const res = verifyPricing(pricing, { 'claude-mystery-1': { costUSD: 1 }, 'claude-haiku-5-5': { costUSD: 1 } });
  assert.equal(res[0].ok, null);
  assert.match(res[0].reason, /no pricing entry/);
  assert.match(res[1].reason, /tiered/);
});

test('priceMessage: tiers, geo, speed and unknown model', () => {
  const u = { input: 1_000_000, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
  assert.equal(priceMessage(pricing, u, { model: 'claude-sonnet-5-5' }).usd, 2);
  assert.ok(Math.abs(priceMessage(pricing, u, { model: 'claude-sonnet-5-5', geo: 'us' }).usd - 2.2) < 1e-9);
  assert.equal(priceMessage(pricing, { ...u, input: 50_000 }, { model: 'claude-haiku-5-5' }).usd, 0.005);
  assert.equal(priceMessage(pricing, { ...u, input: 200_000 }, { model: 'claude-haiku-5-5' }).usd, 0.1);
  assert.match(priceMessage(pricing, u, { model: 'claude-sonnet-5-5', speed: 'fast' }).reason, /unpriced speed mode/);
  assert.match(priceMessage(pricing, u, { model: 'claude-sonnet-5-5', geo: 'eu' }).reason, /unrecognized inference_geo/);
  assert.match(priceMessage(pricing, u, { model: 'nope' }).reason, /no pricing entry/);
});

test('effective-dated rates: dated entry wins after its date, baseline before', () => {
  const m = { rates: [{ effective_from: null, tiers: [{ id: 'old' }] }, { effective_from: '2027-01-01T00:00:00Z', tiers: [{ id: 'new' }] }] };
  assert.equal(rateEntryAt(m, '2026-06-01T00:00:00Z').tiers[0].id, 'old');
  assert.equal(rateEntryAt(m, '2027-02-01T00:00:00Z').tiers[0].id, 'new');
  assert.equal(rateEntryAt({ rates: [{ effective_from: '2027-01-01T00:00:00Z', tiers: [] }] }, '2026-01-01T00:00:00Z'), null);
});

test('transcript parser dedupes repeated rows by message id and keeps the final usage', () => {
  const p = parseClaudeTranscript(transcript(), { pricing });
  assert.equal(p.messages, 2); // A and B counted once each; C has no usage, D is zero
  const t = p.tokens_by_model['claude-sonnet-5-5'];
  assert.equal(t.output, 260 + 1000);
  assert.equal(t.cache_read, 172838 + 1000);
  assert.equal(t.cache_write_1h, 32447);
  assert.equal(t.thinking, 117 * 2);
  assert.deepEqual(p.models, ['claude-sonnet-5-5']);
  assert.deepEqual(p.models_zero_usage, ['claude-sonnet-4-6']);
  assert.equal(p.bad_lines, 1);
  assert.deepEqual(p.efforts, ['medium']);
});

test('reconciliation shows what the transcript rows do not account for', () => {
  const p = parseClaudeTranscript(transcript(), { pricing });
  assert.equal(p.reconciliation.output.transcript_before_snapshot, 1260);
  assert.equal(p.reconciliation.output.cost_state, 65403);
  assert.equal(p.reconciliation.output.missing_from_transcript, 65403 - 1260);
});

test('rows after the last cost-state snapshot are a separate tail, not a reconciliation gap', () => {
  const t = transcript() + asst('msg_late', '2026-10-26T22:30:00.000Z', U({ output_tokens: 500, input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })) + '\n';
  const p = parseClaudeTranscript(t, { pricing });
  assert.equal(p.after_last_cost_state.messages, 1);
  assert.equal(p.after_last_cost_state.tokens.output, 500);
  assert.ok(p.after_last_cost_state.usd_known > 0);
  assert.equal(p.reconciliation.output.transcript_before_snapshot, 1260, 'tail must not leak into the comparison');
  const { telemetry, extras } = buildClaudeTelemetry({ transcript: t, pricing });
  assert.equal(telemetry.cost.value, 2.9066679);
  assert.match(telemetry.cost.note, /1 assistant message\(s\) came after the last cost-state snapshot/);
  assert.match(telemetry.tokens_output.note, /after the last cost-state snapshot/);
  assert.equal(extras.after_last_cost_state.messages, 1);
});

test('no tail note when the snapshot is the last row', () => {
  const { telemetry } = buildClaudeTelemetry({ transcript: transcript(), pricing });
  assert.equal(telemetry.cost.note, undefined);
});

test('cache writes with no tier split are unpriced, not guessed', () => {
  assert.equal(normalizeUsage({ cache_creation_input_tokens: 500 }).split_known, false);
  assert.equal(normalizeUsage({ cache_creation_input_tokens: 0 }).split_known, true);
  const t = `${asst('m1', '2026-10-26T22:00:00Z', { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500 })}\n`;
  const p = parseClaudeTranscript(t, { pricing });
  assert.equal(p.transcript_cost.messages_unpriced, 1);
  assert.deepEqual(p.transcript_cost.reasons, ['cache write tier unknown']);
});

test('telemetry prefers cost-state for cost and tokens, and passes the report contract shapes', () => {
  const { telemetry, extras } = buildClaudeTelemetry({ transcript: transcript(), pricing, numstat: '3\t1\ta.js\n-\t-\timg.png\n', junit: '<testsuites tests="10" failures="1" errors="0" skipped="2"></testsuites>' });
  assert.equal(telemetry.cost.value, 2.9066679);
  assert.equal(telemetry.cost.tool, 'claude-code cost-state');
  assert.equal(telemetry.cost_unit.value, 'usd_api_equivalent');
  assert.equal(telemetry.tokens_input.value, 12336);
  assert.equal(telemetry.tokens_cache_write.value, 204380);
  assert.equal(telemetry.duration_seconds.value, 1155.971);
  assert.deepEqual(telemetry.model.value, ['claude-sonnet-5-5']);
  assert.equal(telemetry.files_changed.value, 2);
  assert.equal(telemetry.lines_added.value, 3);
  assert.match(telemetry.lines_added.note, /binary/);
  assert.equal(telemetry.tests_passed.value, 7);
  assert.equal(telemetry.tests_failed.value, 1);
  assert.equal(extras.pricing_verification[0].ok, true);
  for (const k of TELEMETRY_KEYS) assert.ok(telemetry[k], k);
  const report = { contract_version: 1, issue: '1', outcome: 'blocked', blocked_reason: 'x', pr: null, pr_reason: 'x', criteria: [], review: { dispatched: false }, telemetry, tangents: [] };
  assert.deepEqual(checkReport(report), []);
});

test('without a cost-state row, cost is null with a reason and tokens are labeled unreconciled', () => {
  const { telemetry, extras } = buildClaudeTelemetry({ transcript: transcript({ withCostState: false }), pricing });
  assert.equal(telemetry.cost.value, null);
  assert.match(telemetry.cost.reason, /no cost-state/);
  assert.equal(telemetry.tokens_output.value, 1260);
  assert.match(telemetry.tokens_output.note, /not reconciled/);
  assert.ok(extras.transcript_cost.usd_known > 0);
  assert.equal(telemetry.duration_seconds.value, null);
  assert.equal(telemetry.tests_passed.value, null);
  assert.match(telemetry.files_changed.reason, /no git numstat/);
});

test('cost-state flagging an unknown model cost is never reported as a number', () => {
  const t = transcript().replace('"hasUnknownModelCost":false', '"hasUnknownModelCost":true');
  const { telemetry } = buildClaudeTelemetry({ transcript: t, pricing });
  assert.equal(telemetry.cost.value, null);
  assert.match(telemetry.cost.reason, /unknown cost/);
});

test('copilot parser is honest: every field null with a reason, credits never converted', () => {
  const { telemetry, extras } = buildCopilotTelemetry();
  assert.equal(extras.implemented, false);
  for (const k of TELEMETRY_KEYS) {
    assert.equal(telemetry[k].value, null);
    assert.match(telemetry[k].reason, /never converted to dollars/);
  }
});

test('numstat and junit parsing', () => {
  assert.deepEqual(parseNumstat('1\t2\ta\n4\t0\tb\n'), { files: 2, added: 5, removed: 2, binary: 0 });
  assert.deepEqual(parseNumstat(''), { files: 0, added: 0, removed: 0, binary: 0 });
  assert.deepEqual(parseJunit('<testsuite tests="3" failures="1" errors="0" skipped="0"/><testsuite tests="2" failures="0" errors="1" skipped="1"/>'), { tests: 5, failed: 2, skipped: 1, passed: 2 });
  assert.equal(parseJunit('<testsuites tests="4" failures="0" errors="0" skipped="0"><testsuite tests="4"/></testsuites>').tests, 4);
});

test('pricing age', () => {
  assert.equal(pricingAgeDays({ retrieved: '2026-10-26' }, new Date('2026-11-05T12:00:00Z')), 10);
  assert.equal(pricingAgeDays({ retrieved: 'garbage' }), null);
  assert.ok(fs.existsSync(new URL('../argus/pricing/anthropic.json', import.meta.url)));
});
