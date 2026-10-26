// Cost from tokens and a versioned, effective-dated rate file. Never guesses:
// an unknown model, speed mode, region or missing cache split yields null with a reason.
import fs from 'node:fs';
import { ArgusError, readJson } from './util.mjs';

export function loadPricing(file) {
  const p = readJson(file);
  if (p.unit !== 'usd_per_million_tokens') throw new ArgusError(`Unsupported pricing unit in ${file}: ${p.unit}`);
  return p;
}

/** Pick the rate entry in effect at `ts` (ISO string). Dated entries win over the undated baseline. */
export function rateEntryAt(model, ts) {
  const entries = model.rates ?? [];
  const dated = entries.filter((e) => e.effective_from).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const hit = [...dated].reverse().find((e) => !ts || e.effective_from <= ts);
  if (hit) return hit;
  const baseline = entries.find((e) => !e.effective_from);
  if (baseline && (!dated.length || !ts || ts < dated[0].effective_from)) return baseline;
  return null;
}

const nullCost = (reason) => ({ usd: null, reason });

/**
 * Price one API message.
 * usage: { input, output, cache_read, cache_write_5m, cache_write_1h } in tokens (numbers).
 * ctx: { model, ts, geo, speed }.
 * Returns { usd, reason? }.
 */
export function priceMessage(pricing, usage, ctx) {
  const model = pricing.models[ctx.model];
  if (!model) return nullCost(`no pricing entry for model ${ctx.model}; add it to pricing/anthropic.json`);
  if (ctx.speed && ctx.speed !== 'standard') return nullCost(`unpriced speed mode: ${ctx.speed}`);
  const geoKey = ctx.geo ?? 'global';
  const geo = pricing.geo_multipliers?.[geoKey];
  if (geo === undefined) return nullCost(`unrecognized inference_geo: ${ctx.geo}`);
  const entry = rateEntryAt(model, ctx.ts);
  if (!entry) return nullCost(`no rate in effect for ${ctx.model} at ${ctx.ts}`);
  const prompt = usage.input + usage.cache_read + usage.cache_write_5m + usage.cache_write_1h;
  const tier = entry.tiers.find((t) => t.max_prompt_tokens === null || prompt <= t.max_prompt_tokens);
  if (!tier) return nullCost('no pricing tier matches prompt size');
  const usd =
    ((usage.input * tier.input + usage.output * tier.output + usage.cache_read * tier.cache_read +
      usage.cache_write_5m * tier.cache_write_5m + usage.cache_write_1h * tier.cache_write_1h) / 1e6) * geo;
  return { usd };
}

/**
 * Ground-truth check: recompute each model's cost from Claude Code's own aggregated token counts
 * and compare with its reported costUSD. A mismatch means the rate file is stale or wrong.
 * modelUsage is the `cost-state.modelUsage` object.
 */
export function verifyPricing(pricing, modelUsage, { tolerance = 1e-6 } = {}) {
  const results = [];
  for (const [id, u] of Object.entries(modelUsage ?? {})) {
    const model = pricing.models[id];
    if (!model) { results.push({ model: id, ok: null, reason: 'no pricing entry' }); continue; }
    const entry = rateEntryAt(model, null) ?? model.rates?.[0];
    if (entry.tiers.length > 1) { results.push({ model: id, ok: null, reason: 'tiered pricing needs per-request tokens' }); continue; }
    if (typeof u.costUSD !== 'number') { results.push({ model: id, ok: null, reason: 'no reported costUSD' }); continue; }
    const t = entry.tiers[0];
    const computed = ((u.inputTokens ?? 0) * t.input + (u.outputTokens ?? 0) * t.output + (u.cacheReadInputTokens ?? 0) * t.cache_read +
      (u.cacheCreationEphemeral5mInputTokens ?? 0) * t.cache_write_5m + (u.cacheCreationEphemeral1hInputTokens ?? 0) * t.cache_write_1h) / 1e6;
    const delta = computed - u.costUSD;
    results.push({ model: id, ok: Math.abs(delta) <= tolerance * Math.max(1, Math.abs(u.costUSD)), computed_usd: computed, reported_usd: u.costUSD, delta_usd: delta });
  }
  return results;
}

/** Days since the pricing file was retrieved. null when unparseable. */
export function pricingAgeDays(pricing, now = new Date()) {
  const t = Date.parse(pricing.retrieved);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 86400000);
}

export const defaultPricingFile = (argusDir) => `${argusDir}/pricing/anthropic.json`;
export const pricingExists = (file) => fs.existsSync(file);
