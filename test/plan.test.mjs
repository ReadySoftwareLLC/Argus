import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, patternsOverlap, topoWaves } from '../argus/tools/lib/plan.mjs';

const s = (id, depends_on = [], files = [], repo) => ({ id, depends_on, files, repo });

test('independent stories share one wave', () => {
  const r = buildPlan([s('1', [], ['a.js']), s('2', [], ['b.js'])]);
  assert.deepEqual(r.waves.map((w) => w.stories), [['1', '2']]);
});

test('dependencies force serial waves', () => {
  const r = buildPlan([s('1'), s('2', ['1']), s('3', ['2'])]);
  assert.deepEqual(r.waves.map((w) => w.stories), [['1'], ['2'], ['3']]);
});

test('db -> service -> ui style chain with a parallel sibling', () => {
  const r = buildPlan([s('db', [], ['m.sql'], 'db'), s('api', ['db'], ['api/**'], 'api'), s('ui', ['api'], ['ui/**'], 'ui'), s('docs', [], ['README.md'])], { repos: ['db', 'api', 'ui'] });
  assert.ok(r.ok);
  assert.deepEqual(r.waves[0].stories.sort(), ['db', 'docs']);
  assert.deepEqual(r.waves[1].stories, ['api']);
});

test('cycle is reported, not planned', () => {
  const r = buildPlan([s('1', ['2']), s('2', ['1']), s('3')]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /cycle among: 1, 2/);
});

test('unknown dependency, duplicate id, self dependency, unknown repo', () => {
  assert.match(buildPlan([s('1', ['9'])]).errors.join(), /unknown story 9/);
  assert.match(buildPlan([s('1'), s('1')]).errors.join(), /duplicate story id: 1/);
  assert.match(buildPlan([s('1', ['1'])]).errors.join(), /depends on itself/);
  assert.match(buildPlan([s('1', [], [], 'zzz')], { repos: ['a'] }).errors.join(), /unknown repo zzz/);
});

test('file overlap serializes concurrent stories and says why', () => {
  const r = buildPlan([s('1', [], ['src/a.js']), s('2', [], ['src/a.js']), s('3', [], ['src/z.js'])]);
  assert.deepEqual(r.waves.map((w) => w.stories), [['1', '3'], ['2']]);
  assert.equal(r.serialized[0].story, '2');
  assert.equal(r.serialized[0].because, '1');
  assert.deepEqual(r.serialized[0].overlaps, ['src/a.js']);
});

test('max_concurrent chunks a wave', () => {
  const r = buildPlan([s('1'), s('2'), s('3'), s('4'), s('5')], { maxConcurrent: 2 });
  assert.deepEqual(r.waves.map((w) => w.stories.length), [2, 2, 1]);
});

test('glob overlap detection', () => {
  assert.ok(patternsOverlap('src/**', 'src/a/b.js'));
  assert.ok(patternsOverlap('src/**', 'src/a/**'));
  assert.ok(patternsOverlap('src/*.js', 'src/x.js'));
  assert.ok(!patternsOverlap('src/*.js', 'lib/x.js'));
  assert.ok(!patternsOverlap('a.js', 'b.js'));
  assert.ok(!patternsOverlap('api/**', 'ui/**'));
});

test('topoWaves handles empty input', () => {
  assert.deepEqual(topoWaves([]), { waves: [], cycle: null });
});
