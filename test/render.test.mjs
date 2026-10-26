import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderTemplate, lintPrompt } from '../argus/tools/lib/render.mjs';

const worker = fs.readFileSync(new URL('../argus/templates/worker-prompt.md', import.meta.url), 'utf8');

const data = {
  issue: '12', title: 'Add export', argus_dir: 'argus', issue_url: 'https://github.com/o/r/issues/12',
  repo: 'web', repo_path: '.', branch: 'argus/12-export', requirements_path: 'orchestration/12/requirements.md',
  summary: 'Let admins export the list.', acceptance_criteria: ['Admin sees Export', 'CSV downloads'],
  out_of_scope: ['PDF export'], rules: ['docs/rules'], policies: ['audit-trail: see `docs/a.md`'],
  test_command: 'npm test', story_dir: 'orchestration/12', parking_list: 'orchestration/parking-list.md',
};

test('renders arrays as bullet lists and dotted paths', () => {
  assert.equal(renderTemplate('{{a.b}}\n{{xs}}', { a: { b: 'v' }, xs: ['1', '2'] }), 'v\n- 1\n- 2');
});

test('missing field throws and names every missing key', () => {
  assert.throws(() => renderTemplate('{{a}} {{b}} {{c}}', { a: 'x' }), /b, c/);
});

test('empty string and empty array count as missing, never silently blank', () => {
  assert.throws(() => renderTemplate('{{a}}', { a: '' }), /a/);
  assert.throws(() => renderTemplate('{{a}}', { a: [] }), /a/);
});

test('full worker prompt renders and lints clean', () => {
  const out = renderTemplate(worker, data);
  const res = lintPrompt(out, { budget: 2500 });
  assert.deepEqual(res.problems, []);
  assert.ok(res.ok);
  assert.ok(res.tokens > 0);
});

test('lint flags unresolved placeholders, missing and empty sections, and budget', () => {
  const res = lintPrompt('# t\n{{x}}\n\n## Story\n\n## Commands\nrun\n', { budget: 5 });
  const p = res.problems.join('\n');
  assert.match(p, /unresolved placeholders: x/);
  assert.match(p, /over budget/);
  assert.match(p, /missing section: ## Acceptance criteria/);
  assert.match(p, /empty section: ## Story/);
  assert.equal(res.ok, false);
});
