// Enforces contracts/final-report.md. A field is machine-sourced, self-reported, or null with a reason.
export const TELEMETRY_KEYS = [
  'model', 'reasoning_effort', 'duration_seconds', 'tests_passed', 'tests_failed',
  'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write',
  'cost', 'cost_unit', 'files_changed', 'lines_added', 'lines_removed',
];
const OUTCOMES = ['done', 'blocked', 'halted'];
const STATUSES = ['met', 'unmet', 'unverifiable'];
const COST_UNITS = ['usd_api_equivalent', 'credits'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Returns an error string or null. */
export function checkTelemetryField(key, f) {
  if (!isObj(f)) return `telemetry.${key} must be an object`;
  if (!('value' in f)) return `telemetry.${key} is missing "value"`;
  if (f.value === null) {
    if (typeof f.reason !== 'string' || !f.reason.trim()) return `telemetry.${key} is null without a reason`;
    if (f.source !== undefined) return `telemetry.${key} is null but has a source`;
    return null;
  }
  if (f.source === 'machine') {
    if (typeof f.tool !== 'string' || !f.tool.trim()) return `telemetry.${key} is machine-sourced without a tool name`;
    return null;
  }
  if (f.source === 'self_reported') return null;
  return `telemetry.${key} has a value but source must be "machine" or "self_reported"`;
}

export function checkReport(r) {
  const errs = [];
  if (!isObj(r)) return ['report must be an object'];
  if (r.contract_version !== 1) errs.push('contract_version must be 1');
  if (typeof r.issue !== 'string' || !r.issue) errs.push('issue must be a non-empty string');
  if (!OUTCOMES.includes(r.outcome)) errs.push(`outcome must be one of ${OUTCOMES.join(', ')}`);

  if (r.outcome === 'done') {
    if (!isObj(r.pr) || !r.pr.url || !Number.isInteger(r.pr.number)) errs.push('outcome done requires pr.url and integer pr.number');
  } else if (r.pr == null && !r.pr_reason) errs.push('pr is null without pr_reason');
  if (r.outcome !== 'done' && !r.blocked_reason) errs.push('blocked_reason is required unless outcome is done');

  if (!Array.isArray(r.criteria)) errs.push('criteria must be an array');
  else {
    r.criteria.forEach((c, i) => {
      if (!c?.criterion) errs.push(`criteria[${i}].criterion is required`);
      if (!STATUSES.includes(c?.status)) errs.push(`criteria[${i}].status must be one of ${STATUSES.join(', ')}`);
      if (c?.status === 'met' && !c.evidence) errs.push(`criteria[${i}] is met without evidence`);
    });
    if (r.outcome === 'done' && r.criteria.some((c) => c.status !== 'met')) errs.push('outcome done but not every criterion is met');
  }

  if (!isObj(r.review)) errs.push('review must be an object');
  else {
    if (typeof r.review.dispatched !== 'boolean') errs.push('review.dispatched must be boolean');
    if (r.review.dispatched === false && r.outcome === 'done') errs.push('outcome done is not allowed when review was not dispatched');
    if (r.review.dispatched === true && !r.review.path) errs.push('review.path is required when dispatched');
    if (r.outcome === 'done' && r.review.verdict !== 'pass') errs.push('outcome done requires review.verdict pass');
  }

  if (!isObj(r.telemetry)) errs.push('telemetry must be an object');
  else {
    for (const k of TELEMETRY_KEYS) {
      if (!(k in r.telemetry)) errs.push(`telemetry.${k} is missing`);
      else {
        const e = checkTelemetryField(k, r.telemetry[k]);
        if (e) errs.push(e);
      }
    }
    const unit = r.telemetry.cost_unit;
    if (isObj(unit) && unit.value !== null && !COST_UNITS.includes(unit.value)) errs.push(`telemetry.cost_unit must be one of ${COST_UNITS.join(', ')} or null`);
    const cost = r.telemetry.cost;
    if (isObj(cost) && cost.value !== null && isObj(unit) && unit.value === null) errs.push('telemetry.cost has a value but cost_unit is null');
  }
  if (!Array.isArray(r.tangents)) errs.push('tangents must be an array');
  return errs;
}
