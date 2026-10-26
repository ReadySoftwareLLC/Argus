// status.md board: generated between markers, never owning the whole file.
// Source data: <orchestration>/<issue>/status.json, optionally refreshed from the live tracker.
import fs from 'node:fs';
import path from 'node:path';
import { ArgusError, readJson, writeFileEnsured } from './util.mjs';
import { STATES, labelFor } from './tracker.mjs';

export const START = '<!-- argus:board:start -->';
export const END = '<!-- argus:board:end -->';

/** Read all <orchestration>/<issue>/status.json files. */
export function readEntries(orchestrationDir) {
  if (!fs.existsSync(orchestrationDir)) return [];
  const entries = [];
  for (const name of fs.readdirSync(orchestrationDir)) {
    const file = path.join(orchestrationDir, name, 'status.json');
    if (fs.existsSync(file)) entries.push({ ...readJson(file), _file: file });
  }
  return entries.sort((a, b) => Number(a.issue) - Number(b.issue) || String(a.issue).localeCompare(String(b.issue)));
}

export function renderBoard(entries, { generatedAt } = {}) {
  const lines = [];
  lines.push(`_Generated${generatedAt ? ` ${generatedAt}` : ''}. Dashboard only: re-fetch the tracker before acting._`, '');
  if (!entries.length) {
    lines.push('No stories tracked yet.');
    return lines.join('\n');
  }
  lines.push('| Issue | Title | State | Repo | PR | Checked |', '| --- | --- | --- | --- | --- | --- |');
  for (const e of entries) {
    const pr = e.pr?.url ? `[#${e.pr.number}](${e.pr.url})` : '';
    lines.push(`| #${e.issue} | ${esc(e.title ?? '')} | ${e.state ?? 'unknown'} | ${e.repo ?? ''} | ${pr} | ${e.checked_at ?? 'never'} |`);
  }
  return lines.join('\n');
}

const esc = (s) => String(s).replace(/\|/g, '\\|');

/** Replace the region between markers, leave everything else untouched. Throws if markers are absent. */
export function spliceBoard(fileText, board) {
  const s = fileText.indexOf(START);
  const e = fileText.indexOf(END);
  if (s === -1 || e === -1 || e < s) throw new ArgusError(`status.md must contain ${START} and ${END}`);
  return `${fileText.slice(0, s + START.length)}\n${board}\n${fileText.slice(e)}`;
}

/** Update a status.json entry from the live issue. Returns the new entry. */
export function refreshEntry(entry, issue, config, now) {
  const prefix = config.tracker.label_prefix ?? 'argus:';
  const labels = issue.labels.map((l) => l.name);
  const state = issue.state?.toLowerCase() === 'closed'
    ? 'done'
    : STATES.find((s) => labels.includes(labelFor(config, s))) ?? 'unlabeled';
  return { ...entry, title: issue.title, state, checked_at: now, live_labels: labels.filter((l) => l.startsWith(prefix)) };
}

export function writeBoard(statusFile, board) {
  const text = fs.readFileSync(statusFile, 'utf8');
  writeFileEnsured(statusFile, spliceBoard(text, board));
}
