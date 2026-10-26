// Template rendering and prompt lint. No field is guessed: a missing value is an error.
import fs from 'node:fs';
import path from 'node:path';
import { ArgusError, estimateTokens } from './util.mjs';

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function lookup(data, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
}

function format(value) {
  if (Array.isArray(value)) return value.length ? value.map((v) => `- ${v}`).join('\n') : null;
  if (value === null || value === undefined) return null;
  return String(value);
}

/** Fill {{key}} placeholders. Throws listing every missing or empty key. */
export function renderTemplate(text, data) {
  const missing = new Set();
  const out = text.replace(PLACEHOLDER, (_, key) => {
    const v = format(lookup(data, key));
    if (v === null || v === '') {
      missing.add(key);
      return `{{${key}}}`;
    }
    return v;
  });
  if (missing.size) {
    throw new ArgusError(`Missing or empty template fields: ${[...missing].join(', ')}. Supply them in --data; Argus does not guess.`);
  }
  return out;
}

/** Find a template: template_dir override first, then the bundled argus/templates. */
export function findTemplate(name, { argusDir, templateDir }) {
  const file = name.endsWith('.md') ? name : `${name}.md`;
  for (const dir of [templateDir, path.join(argusDir, 'templates')]) {
    if (!dir) continue;
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  throw new ArgusError(`Template not found: ${file}`);
}

export const WORKER_REQUIRED_SECTIONS = ['## Story', '## Acceptance criteria', '## Out of scope', '## Rules to apply', '## Commands'];

/**
 * Lint a generated prompt. Returns { ok, tokens, budget, problems }.
 * tokens is an estimate (chars / 4).
 */
export function lintPrompt(text, { budget, requiredSections = WORKER_REQUIRED_SECTIONS } = {}) {
  const problems = [];
  const tokens = estimateTokens(text);
  const unresolved = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (unresolved.length) problems.push(`unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
  if (budget && tokens > budget) problems.push(`over budget: ~${tokens} tokens (estimate), budget ${budget}`);
  for (const heading of requiredSections) {
    const idx = text.indexOf(`\n${heading}\n`);
    if (idx === -1) {
      problems.push(`missing section: ${heading}`);
      continue;
    }
    const rest = text.slice(idx + heading.length + 2);
    const next = rest.search(/\n## /);
    const body = (next === -1 ? rest : rest.slice(0, next)).trim();
    if (!body) problems.push(`empty section: ${heading}`);
  }
  return { ok: problems.length === 0, tokens, budget: budget ?? null, problems };
}
