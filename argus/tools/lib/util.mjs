// Shared helpers. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';

/** Rough token estimate. ~4 chars per token. Labeled an estimate everywhere it is shown. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
}

export function writeFileEnsured(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export class ArgusError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'ArgusError';
    this.code = code;
  }
}

/** Parse argv into { _: [positionals], flags: {k: v|true} }. */
export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}
