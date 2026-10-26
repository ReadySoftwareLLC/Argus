// One-way export of a solution's ledger to a primary solution, for cross-product learning.
// The primary never writes back. Each solution's budget stays its own: imports are kept apart from
// the primary's ledger, and are read only by the index.
import fs from 'node:fs';
import path from 'node:path';
import { ArgusError } from './util.mjs';
import { loadConfig } from './config.mjs';
import { readEvents, ledgerPath } from './ledger.mjs';

export const IMPORTS_DIR = 'imports';

/** Stable id of a solution: its tracker repo. */
export const solutionId = (config) => config.tracker.repo;
const slug = (id) => id.replace(/[^\w.-]+/g, '__');

export const importsDir = (config) => path.join(config._orchestration_abs, IMPORTS_DIR);

/** Resolve the primary solution from `primary` in config (path to its config file or its folder). */
export function loadPrimary(config) {
  if (!config.primary) throw new ArgusError('No "primary" in argus.config.json. Set it to the primary solution\'s config path to export.');
  let p = path.resolve(config._base, config.primary);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'argus.config.json');
  if (!fs.existsSync(p)) throw new ArgusError(`primary config not found: ${p}`);
  if (p === config._file) throw new ArgusError('primary points at this same config. Export goes to a different solution.');
  const primary = loadConfig({ path: p, via: 'primary' });
  if (solutionId(primary) === solutionId(config)) throw new ArgusError(`primary is the same solution (${solutionId(config)}).`);
  return primary;
}

/**
 * Write this solution's ledger events into the primary, tagged with their origin. The file is a full
 * snapshot, so running it again is idempotent. Returns { file, events, solution }.
 */
export function exportLedger(config, primary) {
  const events = readEvents(ledgerPath(config)).map((e) => ({ ...e, solution: solutionId(config), solution_name: config.product.name }));
  const file = path.join(importsDir(primary), `${slug(solutionId(config))}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return { file, events: events.length, solution: solutionId(config) };
}

/** Events imported from other solutions, in a stable order. */
export function readImports(config) {
  const dir = importsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readEvents(path.join(dir, f)));
}
