// Argus ships zero product knowledge. Fail if anything under argus/ names a real product,
// or references the workflow tool this toolkit replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN = [/stashbar/i, /stationready/i, /wells\s*fargo/i, /\bai-wires\b/i, /\bjira\b/i, /\bhoardware\b/i, /\bvftv\b/i];
const ROOT = new URL('../argus/', import.meta.url).pathname;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('no product-specific names inside argus/', () => {
  const hits = [];
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${path.relative(ROOT, file)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('quickref stays small (always-loaded file)', () => {
  const tokens = Math.ceil(fs.readFileSync(path.join(ROOT, 'quickref.md'), 'utf8').length / 4);
  assert.ok(tokens <= 1000, `quickref is ~${tokens} tokens, budget 1000`);
});
