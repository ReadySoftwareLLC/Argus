import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReport, checkTelemetryField, TELEMETRY_KEYS } from '../argus/tools/lib/report.mjs';

const machine = (value, tool = 'git') => ({ value, source: 'machine', tool });
const unknown = (reason = 'no session log available') => ({ value: null, reason });

function good() {
  const telemetry = Object.fromEntries(TELEMETRY_KEYS.map((k) => [k, unknown()]));
  telemetry.files_changed = machine(3, 'git diff --numstat');
  return {
    contract_version: 1, issue: '12', outcome: 'done',
    pr: { url: 'https://github.com/o/r/pull/5', number: 5 },
    criteria: [{ criterion: 'Export works', status: 'met', evidence: 'test/export.test:10' }],
    review: { dispatched: true, verdict: 'pass', path: 'orchestration/12/review.md' },
    telemetry, tangents: [],
  };
}

test('a complete report passes', () => assert.deepEqual(checkReport(good()), []));

test('null without reason fails; null with source fails', () => {
  assert.match(checkTelemetryField('cost', { value: null }), /without a reason/);
  assert.match(checkTelemetryField('cost', { value: null, reason: 'x', source: 'machine' }), /null but has a source/);
});

test('value needs machine+tool or self_reported', () => {
  assert.match(checkTelemetryField('model', { value: 'm' }), /source must be/);
  assert.match(checkTelemetryField('model', { value: 'm', source: 'machine' }), /without a tool/);
  assert.equal(checkTelemetryField('model', { value: 'm', source: 'self_reported' }), null);
});

test('missing telemetry key fails', () => {
  const r = good();
  delete r.telemetry.cost;
  assert.match(checkReport(r).join(), /telemetry.cost is missing/);
});

test('done requires pr, passing review, dispatched review, all criteria met', () => {
  let r = good(); r.pr = null;
  assert.match(checkReport(r).join(), /requires pr.url/);
  r = good(); r.review.verdict = 'changes_requested';
  assert.match(checkReport(r).join(), /requires review.verdict pass/);
  r = good(); r.review = { dispatched: false };
  assert.match(checkReport(r).join(), /review was not dispatched/);
  r = good(); r.criteria[0].status = 'unverifiable';
  assert.match(checkReport(r).join(), /not every criterion is met/);
});

test('blocked report needs a reason and may omit the pr with a reason', () => {
  const r = good();
  r.outcome = 'blocked'; r.pr = null; r.review = { dispatched: false };
  assert.match(checkReport(r).join(), /pr is null without pr_reason/);
  assert.match(checkReport(r).join(), /blocked_reason is required/);
  r.pr_reason = 'review could not be dispatched'; r.blocked_reason = 'no sub-agent dispatch in host';
  assert.deepEqual(checkReport(r), []);
});

test('a met criterion needs evidence', () => {
  const r = good(); r.criteria[0].evidence = '';
  assert.match(checkReport(r).join(), /met without evidence/);
});

test('cost with a value requires a cost_unit, credits are never converted', () => {
  const r = good();
  r.telemetry.cost = machine(1.2, 'parser');
  assert.match(checkReport(r).join(), /cost_unit is null/);
  r.telemetry.cost_unit = machine('credits', 'parser');
  assert.deepEqual(checkReport(r), []);
  r.telemetry.cost_unit = machine('dollars', 'parser');
  assert.match(checkReport(r).join(), /cost_unit must be one of/);
});
