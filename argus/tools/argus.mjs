#!/usr/bin/env node
// Argus CLI. Zero dependencies, Node >= 22. Deterministic work lives here so it costs no LLM tokens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgusError, parseArgs, readJson, writeFileEnsured } from './lib/util.mjs';
import { discoverConfig, loadConfig, requirementsPath, storyDir, applicablePolicies } from './lib/config.mjs';
import { findTemplate, renderTemplate, lintPrompt } from './lib/render.mjs';
import { buildPlan, launchPlan } from './lib/plan.mjs';
import { checkReport } from './lib/report.mjs';
import { createTracker, ensureLabels } from './lib/tracker.mjs';
import { buildOnboardConfig, ensureGitignore, parseAlso } from './lib/onboard.mjs';
import { readEntries, renderBoard, writeBoard, refreshEntry } from './lib/status.mjs';
import { buildClaudeTelemetry, buildCopilotTelemetry } from './lib/telemetry.mjs';
import { loadPricing, pricingAgeDays } from './lib/pricing.mjs';
import { exportLedger, loadPrimary, readImports, solutionId } from './lib/export.mjs';
import { LOCK_NAME, hashTree, readLock, resolveSource, runSync, sourceArgusDir, verifyTree } from './lib/sync.mjs';
import { appendEvent, budgetCheck, eventFromReport, indexPath, ledgerPath, queryIndex, readEvents, rebuildIndex, rollup, templateFromPrompt } from './lib/ledger.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const argusDir = path.resolve(toolDir, '..');

const HELP = `argus <command> [options]

  onboard --name <n> [--tracker o/r] [--anchor k] [--also k=path,...] [--primary p]
         [--labels] [--dry-run] [--force]   write argus.config.json from detected facts (nothing guessed)
  config [--policies]                 resolve + validate config
  init <issue>                        scaffold <orchestration>/<issue>/ and base files
  render <template> --data <f.json>   fill a template; fails on any missing field
         [--story <issue>] [--out f]  --story injects config-derived fields
  lint <prompt.md>                    size budget, placeholders, required sections
  plan <plan.json> [--launch]         validate story graph, print waves (or manual launch plan)
  claim <issue> --worker <id>         claim protocol (earliest claim wins)
  status [--refresh]                  rebuild the board in status.md
  report-check <report.json>          enforce the final-report contract
  telemetry --claude <log.jsonl>      machine telemetry from a Claude Code transcript
         [--numstat f] [--junit f] [--merge <final-report.json>]
  telemetry --host copilot --log <events.jsonl> [same options]   (AIU, never dollars)
  ledger add <final-report.json>      append the story to ledger.jsonl (idempotent)
  costs                               rollup + budget guard (unknown cost is not zero)
  index [--sql "SELECT ..."] [--no-imports]
                                      rebuild or query the SQLite index
  export                              copy this ledger to the "primary" solution (one way)
  pricing [--max-age-days N]          rate file age; fails when stale
  sync [--from <dir|git-url>] [--ref r] [--dry-run] [--verify] [--force]
                                      vendor argus/ into this repo, record argus.lock

global: --config <path>  --json`;

function load(flags) {
  const found = discoverConfig({ flag: flags.config, toolDir });
  if (!found) throw new ArgusError('No argus.config.json found. Use --config, set ARGUS_CONFIG, or run from inside the consuming repo.');
  return loadConfig(found);
}

const print = (v) => process.stdout.write(typeof v === 'string' ? `${v}\n` : `${JSON.stringify(v, null, 2)}\n`);

/** Config-derived values a template may use, so the orchestrator never retypes facts. */
export function derivedFields(config, issue, data) {
  const repo = config.repos[data.repo_key ?? config.anchor];
  const rules = repo?.rules_path ? [path.posix.join(repo.path, repo.rules_path).replace(/^\.\//, '')] : [];
  const policies = applicablePolicies(config, data.tags ?? []).map((p) => (p.file ? `${p.name}: see \`${p.file}\`` : `${p.name}: ${p.answer}`));
  const dir = path.relative(config._base, storyDir(config, issue)) || '.';
  return {
    argus_dir: path.relative(config._base, argusDir) || '.',
    story_dir: dir,
    parking_list: path.posix.join(config.orchestration_dir, 'parking-list.md'),
    requirements_path: path.relative(config._base, requirementsPath(config, issue)),
    diff_path: path.posix.join(dir, 'diff.diff'),
    repo: repo ? data.repo_key ?? config.anchor : undefined,
    repo_path: repo?.path,
    test_command: repo?.test_command,
    rules,
    policies,
    issue,
    issue_url: `https://github.com/${config.tracker.repo}/issues/${issue}`,
  };
}

/** Budget guard for dispatch. Reads the ledger fresh. Over budget halts; incomplete cost only warns. */
export function dispatchBudget(config) {
  return budgetCheck(rollup(readEvents(ledgerPath(config))), config.limits.epic_budget_usd);
}

const commands = {
  onboard(args) {
    const f = args.flags;
    const base = path.resolve(typeof f.base === 'string' ? f.base : process.cwd());
    const file = path.join(base, 'argus.config.json');
    const { config, evidence, unset } = buildOnboardConfig({
      base, name: typeof f.name === 'string' ? f.name : undefined, tracker: typeof f.tracker === 'string' ? f.tracker : undefined,
      anchor: typeof f.anchor === 'string' ? f.anchor : undefined, also: parseAlso(typeof f.also === 'string' ? f.also : ''),
      primary: typeof f.primary === 'string' ? f.primary : undefined,
    });
    if (f['dry-run']) return print({ dry_run: true, would_write: file, config, evidence, unset });
    if (fs.existsSync(file) && !f.force) throw new ArgusError(`${file} already exists. Edit it, or pass --force to replace it.`);
    writeFileEnsured(file, `${JSON.stringify(config, null, 2)}\n`);
    const gitignore = ensureGitignore(base);
    let labels = null;
    if (f.labels) labels = ensureLabels(loadConfig({ path: file, via: 'onboard' }));
    print({ wrote: file, evidence, unset, gitignore_updated: gitignore, labels: labels ?? 'not created (pass --labels to create them with gh)', next: ['argus config', 'argus init <issue>'] });
  },

  config(args) {
    const config = load(args.flags);
    if (args.flags.policies) return print(applicablePolicies(config, []));
    print({ file: config._file, via: config._via, product: config.product.name, anchor: config.anchor, repos: Object.keys(config.repos), limits: config.limits, host: config.host });
  },

  init(args) {
    const issue = args._[1];
    if (!issue) throw new ArgusError('usage: argus init <issue>');
    const config = load(args.flags);
    const created = [];
    const put = (file, content) => {
      if (fs.existsSync(file)) return;
      writeFileEnsured(file, content);
      created.push(path.relative(config._base, file));
    };
    const tpl = (n) => fs.readFileSync(findTemplate(n, { argusDir, templateDir: config.template_dir && path.resolve(config._base, config.template_dir) }), 'utf8');
    put(path.join(config._orchestration_abs, 'status.md'), tpl('status'));
    put(path.join(config._orchestration_abs, 'parking-list.md'), tpl('parking-list'));
    put(path.join(storyDir(config, issue), 'status.json'), `${JSON.stringify({ issue: String(issue), state: 'ready' }, null, 2)}\n`);
    const req = requirementsPath(config, issue);
    put(req, tpl('requirements').replace('{{issue}}', issue).replace('{{title}}', '').replace('{{ready}}', 'false').replace('{{rounds_used}}', '0'));
    print({ created });
  },

  render(args) {
    const name = args._[1];
    if (!name || !args.flags.data) throw new ArgusError('usage: argus render <template> --data <file.json> [--story <issue>] [--out <file>]');
    const config = load(args.flags);
    let data = readJson(args.flags.data);
    if (args.flags.story) data = { ...Object.fromEntries(Object.entries(derivedFields(config, args.flags.story, data)).filter(([, v]) => v !== undefined)), ...data };
    const file = findTemplate(name, { argusDir, templateDir: config.template_dir && path.resolve(config._base, config.template_dir) });
    const out = renderTemplate(fs.readFileSync(file, 'utf8'), data);
    if (args.flags.out) {
      writeFileEnsured(path.resolve(args.flags.out), out);
      print({ wrote: args.flags.out });
    } else process.stdout.write(out);
  },

  lint(args) {
    const file = args._[1];
    if (!file) throw new ArgusError('usage: argus lint <prompt.md>');
    const config = load(args.flags);
    const res = lintPrompt(fs.readFileSync(file, 'utf8'), { budget: config.limits.prompt_token_budget });
    print(res);
    if (!res.ok) process.exitCode = 1;
  },

  plan(args) {
    const file = args._[1];
    if (!file) throw new ArgusError('usage: argus plan <plan.json>');
    const config = load(args.flags);
    const res = buildPlan(readJson(file).stories ?? [], { maxConcurrent: config.limits.max_concurrent, repos: Object.keys(config.repos) });
    const budget = dispatchBudget(config);
    if (res.ok && budget.over_budget && !args.flags['override-budget']) {
      print({ ok: false, halted: 'budget', budget, action: 'Known cost is at or over limits.epic_budget_usd. Do not dispatch. A human can raise the limit or pass --override-budget.' });
      process.exitCode = 1;
      return;
    }
    if (res.ok && args.flags.launch) {
      const launch = launchPlan(res, (id) => path.relative(config._base, path.join(storyDir(config, id), 'prompt.md')));
      print(budget.limit_usd == null && budget.complete ? launch : `${launch}\nBudget: ${budget.message}${budget.remaining_usd == null ? '' : ` (remaining $${budget.remaining_usd.toFixed(2)})`}`);
    } else print({ ...res, budget });
    if (!res.ok) process.exitCode = 1;
  },

  claim(args) {
    const issue = args._[1];
    if (!issue || !args.flags.worker) throw new ArgusError('usage: argus claim <issue> --worker <id> [--assignee <login>]');
    const config = load(args.flags);
    const budget = dispatchBudget(config);
    if (budget.over_budget && !args.flags['override-budget']) {
      print({ won: false, halted: 'budget', budget, action: 'Known cost is at or over limits.epic_budget_usd. Nothing was claimed. A human can raise the limit or pass --override-budget.' });
      process.exitCode = 1;
      return;
    }
    const res = createTracker(config).claim(issue, args.flags.worker, { assignee: args.flags.assignee });
    print(budget.complete || budget.limit_usd == null ? res : { ...res, budget_warning: budget.message });
    if (!res.won) process.exitCode = 1;
  },

  status(args) {
    const config = load(args.flags);
    let entries = readEntries(config._orchestration_abs);
    const now = new Date().toISOString();
    if (args.flags.refresh) {
      const tracker = createTracker(config);
      entries = entries.map((e) => {
        const next = refreshEntry(e, tracker.getIssue(e.issue), config, now);
        const { _file, ...persist } = next;
        writeFileEnsured(e._file, `${JSON.stringify(persist, null, 2)}\n`);
        return next;
      });
    }
    const statusFile = path.join(config._orchestration_abs, 'status.md');
    if (!fs.existsSync(statusFile)) throw new ArgusError('status.md not found. Run: argus init <issue>');
    writeBoard(statusFile, renderBoard(entries, { generatedAt: now }));
    print({ wrote: path.relative(config._base, statusFile), stories: entries.length, refreshed: Boolean(args.flags.refresh) });
  },

  telemetry(args) {
    const f = args.flags;
    if (f.host === 'copilot') {
      const read = (p) => (p ? fs.readFileSync(p, 'utf8') : undefined);
      const res = buildCopilotTelemetry({ log: read(f.log), numstat: read(f.numstat), junit: read(f.junit) });
      if (f.merge && f.log) {
        const report = readJson(f.merge);
        report.telemetry = res.telemetry;
        writeFileEnsured(f.merge, `${JSON.stringify(report, null, 2)}\n`);
        return print({ merged: f.merge, extras: res.extras });
      }
      return print(res);
    }
    if (!f.claude) throw new ArgusError('usage: argus telemetry --claude <log.jsonl> [--numstat f] [--junit f] [--merge report.json] [--pricing f]  |  --host copilot');
    const read = (p) => (p ? fs.readFileSync(p, 'utf8') : undefined);
    const pricing = loadPricing(f.pricing ?? path.join(argusDir, 'pricing', 'anthropic.json'));
    const res = buildClaudeTelemetry({ transcript: fs.readFileSync(f.claude, 'utf8'), pricing, numstat: read(f.numstat), junit: read(f.junit) });
    if (f.merge) {
      const report = readJson(f.merge);
      report.telemetry = res.telemetry;
      writeFileEnsured(f.merge, `${JSON.stringify(report, null, 2)}\n`);
      return print({ merged: f.merge, extras: res.extras });
    }
    print(res);
  },

  async ledger(args) {
    if (args._[1] !== 'add' || !args._[2]) throw new ArgusError('usage: argus ledger add <final-report.json>');
    const config = load(args.flags);
    const report = readJson(args._[2]);
    const errs = checkReport(report);
    if (errs.length) throw new ArgusError(`Report fails the contract, not recorded:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
    const promptFile = path.join(storyDir(config, report.issue), 'prompt.md');
    const template = templateFromPrompt(fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null);
    print(appendEvent(ledgerPath(config), eventFromReport(report, { template })));
  },

  costs(args) {
    const config = load(args.flags);
    const roll = rollup(readEvents(ledgerPath(config)));
    const budget = budgetCheck(roll, config.limits.epic_budget_usd);
    print({ rollup: roll, budget });
    if (budget.over_budget) process.exitCode = 1;
  },

  export(args) {
    const config = load(args.flags);
    const primary = loadPrimary(config);
    print({ ...exportLedger(config, primary), primary: solutionId(primary), action: 'Commit the file in the primary solution, then run `argus index` there.' });
  },

  async index(args) {
    const config = load(args.flags);
    if (args.flags.sql) return print(await queryIndex(indexPath(config), args.flags.sql));
    // Own events are stamped with this solution's id so queries can group by solution. Imports are
    // other solutions' events exported to this one; they never touch costs or the budget.
    const own = readEvents(ledgerPath(config)).map((e) => ({ ...e, solution: solutionId(config) }));
    const imported = args.flags['no-imports'] ? [] : readImports(config);
    print({ ...(await rebuildIndex([...own, ...imported], indexPath(config))), own: own.length, imported: imported.length });
  },

  sync(args) {
    const f = args.flags;
    const base = path.resolve(f.base === true ? '.' : f.base ?? process.cwd());
    const destDir = path.resolve(base, f.dest === true ? 'argus' : f.dest ?? 'argus');
    const lockFile = path.resolve(base, f.lock === true ? LOCK_NAME : f.lock ?? LOCK_NAME);
    const lock = readLock(lockFile);
    if (f.verify) {
      if (!lock) throw new ArgusError(`No ${path.basename(lockFile)} in ${base}. Run: argus sync --from <source>`);
      const problems = verifyTree({ dest: hashTree(destDir), locked: lock.files });
      print({ ok: problems.length === 0, version: lock.version, commit: lock.commit, problems, action: problems.length ? 'Vendored files differ from argus.lock. Move customizations to template_dir, then: argus sync --force' : 'ok' });
      if (problems.length) process.exitCode = 1;
      return;
    }
    const from = typeof f.from === 'string' ? f.from : lock?.source;
    if (!from) throw new ArgusError('usage: argus sync --from <argus checkout or git url> [--ref r]. No argus.lock to take the source from.');
    const ref = typeof f.ref === 'string' ? f.ref : typeof f.from === 'string' ? undefined : lock?.ref ?? undefined;
    const src = resolveSource({ from, ref });
    try {
      const res = runSync({ srcDir: sourceArgusDir(src.dir), destDir, lockFile, source: { from, ref, commit: src.commit }, dryRun: Boolean(f['dry-run']), force: Boolean(f.force) });
      const by = (a) => res.actions.filter((x) => x.action === a).map((x) => x.path);
      const pending = ['add', 'update', 'remove'].some((a) => by(a).length);
      print({
        dry_run: Boolean(f['dry-run']), from, ref: ref ?? null, commit: res.lock.commit, version: res.lock.version, previous_version: res.prior?.version ?? null,
        added: by('add'), updated: by('update'), removed: by('remove'), unchanged: by('unchanged').length,
        conflicts: res.actions.filter((x) => x.action === 'conflict' || x.action === 'orphan').map((x) => ({ path: x.path, action: x.action, reason: x.reason })),
        forced: Boolean(f.force && !f['dry-run']),
      });
      if (res.blocked.length) process.stderr.write(`argus: ${res.blocked.length} file(s) were edited locally and were left alone. Move customizations to template_dir; --force overwrites them.\n`);
      if (res.blocked.length || (f['dry-run'] && pending)) process.exitCode = 1;
    } finally {
      src.cleanup();
    }
  },

  pricing(args) {
    const file = args.flags.file ?? path.join(argusDir, 'pricing', 'anthropic.json');
    const p = loadPricing(file);
    const age = pricingAgeDays(p);
    const max = Number(args.flags['max-age-days'] ?? 30);
    const stale = age === null || age > max;
    print({ file: path.relative(process.cwd(), file), source_url: p.source_url, retrieved: p.retrieved, age_days: age, max_age_days: max, stale, models: Object.keys(p.models), action: stale ? `Rates may be stale. Re-fetch ${p.source_url}, update the file, and confirm with: argus telemetry --claude <transcript>` : 'ok' });
    if (stale) process.exitCode = 1;
  },

  'report-check'(args) {
    const file = args._[1];
    if (!file) throw new ArgusError('usage: argus report-check <report.json>');
    const errs = checkReport(readJson(file));
    print({ ok: errs.length === 0, errors: errs });
    if (errs.length) process.exitCode = 1;
  },
};

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) return print(HELP);
  if (!commands[cmd]) throw new ArgusError(`Unknown command: ${cmd}\n\n${HELP}`);
  await commands[cmd](args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`argus: ${e.message}\n`);
    process.exit(e instanceof ArgusError ? e.code : 2);
  }
}
