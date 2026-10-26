import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, claimBody, winningClaim, parseClaims, labelFor } from '../argus/tools/lib/tracker.mjs';
import { refreshEntry, renderBoard, spliceBoard, START, END } from '../argus/tools/lib/status.mjs';

const config = { tracker: { type: 'github', repo: 'o/r', label_prefix: 'argus:' } };

/** Fake gh: keeps an in-memory issue so tests never touch the network. */
function fakeGh(issue) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'issue' && b === 'view') return JSON.stringify(issue);
    if (a === 'issue' && b === 'comment') {
      issue.comments.push({ id: String(issue.comments.length + 1), body: args[args.indexOf('--body') + 1], createdAt: new Date(issue.clock++).toISOString() });
      return '';
    }
    if (a === 'issue' && b === 'edit') {
      const add = args.flatMap((x, i) => (x === '--add-label' ? [args[i + 1]] : []));
      const rm = args.flatMap((x, i) => (x === '--remove-label' ? [args[i + 1]] : []));
      issue.labels = issue.labels.filter((l) => !rm.includes(l.name)).concat(add.map((name) => ({ name })));
      return '';
    }
    if (a === 'issue' && b === 'list') return JSON.stringify([{ number: 1, title: 't', labels: [], assignees: [], url: 'u' }]);
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { run, calls };
}
const mk = (over = {}) => ({ number: 5, title: 'T', state: 'OPEN', labels: [], assignees: [], comments: [], url: 'u', body: '', clock: 1_700_000_000_000, ...over });

test('claim body round trips', () => {
  const [c] = parseClaims([{ body: claimBody('w1', new Date('2026-01-01T00:00:00Z')), createdAt: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(c.worker, 'w1');
});

test('earliest claim wins regardless of comment order in the array', () => {
  const comments = [
    { id: '2', body: 'argus-claim:late:2026-01-01T00:00:05Z', createdAt: '2026-01-01T00:00:05Z' },
    { id: '1', body: 'argus-claim:early:2026-01-01T00:00:01Z', createdAt: '2026-01-01T00:00:01Z' },
    { id: '3', body: 'looks good to me', createdAt: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(winningClaim(comments).worker, 'early');
});

test('timestamp tie breaks deterministically', () => {
  const t = '2026-01-01T00:00:00Z';
  const a = winningClaim([{ id: '2', body: `argus-claim:b:${t}`, createdAt: t }, { id: '1', body: `argus-claim:a:${t}`, createdAt: t }]);
  assert.equal(a.worker, 'a');
});

test('claim succeeds on a fresh issue and labels it', () => {
  const issue = mk();
  const { run, calls } = fakeGh(issue);
  const res = createTracker(config, run).claim(5, 'w1', { assignee: 'bot' });
  assert.deepEqual(res, { won: true });
  assert.ok(issue.labels.some((l) => l.name === 'argus:claimed'));
  assert.ok(calls.some((c) => c.includes('--add-assignee')));
});

test('claim refuses when another worker holds the earliest claim, and posts nothing', () => {
  const issue = mk({ comments: [{ id: '1', body: 'argus-claim:other:2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }] });
  const { run, calls } = fakeGh(issue);
  const res = createTracker(config, run).claim(5, 'w1');
  assert.equal(res.won, false);
  assert.equal(res.holder, 'other');
  assert.ok(!calls.some((c) => c[1] === 'comment'));
});

test('claim refuses a closed issue', () => {
  const { run } = fakeGh(mk({ state: 'CLOSED' }));
  assert.equal(createTracker(config, run).claim(5, 'w1').won, false);
});

test('losing a race: a rival claim lands earlier between our read and re-read', () => {
  const issue = mk();
  const { run } = fakeGh(issue);
  const racing = (args) => {
    const out = run(args);
    if (args[1] === 'comment') issue.comments.unshift({ id: '0', body: 'argus-claim:rival:2020-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:00Z' });
    return out;
  };
  const res = createTracker(config, racing).claim(5, 'w1');
  assert.equal(res.won, false);
  assert.match(res.reason, /lost claim race to rival/);
  assert.ok(!issue.labels.some((l) => l.name === 'argus:claimed'), 'loser must not label');
});

test('setState swaps argus labels and leaves others alone', () => {
  const issue = mk({ labels: [{ name: 'argus:ready' }, { name: 'bug' }] });
  const { run } = fakeGh(issue);
  createTracker(config, run).setState(5, 'in-progress');
  assert.deepEqual(issue.labels.map((l) => l.name).sort(), ['argus:in-progress', 'bug']);
  assert.throws(() => createTracker(config, run).setState(5, 'bogus'), /Unknown state/);
});

test('refreshEntry takes state from the live issue, not the stale entry', () => {
  const entry = { issue: '5', state: 'ready' };
  const live = mk({ labels: [{ name: 'argus:in-review' }, { name: 'bug' }] });
  const next = refreshEntry(entry, live, config, '2026-01-01T00:00:00Z');
  assert.equal(next.state, 'in-review');
  assert.equal(next.checked_at, '2026-01-01T00:00:00Z');
  assert.equal(refreshEntry(entry, mk({ state: 'CLOSED' }), config, 'x').state, 'done');
  assert.equal(refreshEntry(entry, mk(), config, 'x').state, 'unlabeled');
});

test('board splice keeps hand-written text and fails without markers', () => {
  const file = `# Status\n\n${START}\nold\n${END}\n\n## Notes\nkeep me\n`;
  const out = spliceBoard(file, renderBoard([{ issue: '5', title: 'A|B', state: 'ready', repo: 'web' }], { generatedAt: 'now' }));
  assert.match(out, /keep me/);
  assert.match(out, /A\\\|B/);
  assert.ok(!out.includes('\nold\n'));
  assert.throws(() => spliceBoard('# no markers', 'x'), /must contain/);
  assert.equal(labelFor(config, 'ready'), 'argus:ready');
});
