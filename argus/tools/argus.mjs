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
import { createTracker } from './lib/tracker.mjs';
import { readEntries, renderBoard, writeBoard, refreshEntry } from './lib/status.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const argusDir = path.resolve(toolDir, '..');

const HELP = `argus <command> [options]

  config [--policies]                 resolve + validate config
  init <issue>                        scaffold <orchestration>/<issue>/ and base files
  render <template> --data <f.json>   fill a template; fails on any missing field
         [--story <issue>] [--out f]  --story injects config-derived fields
  lint <prompt.md>                    size budget, placeholders, required sections
  plan <plan.json> [--launch]         validate story graph, print waves (or manual launch plan)
  claim <issue> --worker <id>         claim protocol (earliest claim wins)
  status [--refresh]                  rebuild the board in status.md
  report-check <report.json>          enforce the final-report contract

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

const commands = {
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
    if (res.ok && args.flags.launch) {
      print(launchPlan(res, (id) => path.relative(config._base, path.join(storyDir(config, id), 'prompt.md'))));
    } else print(res);
    if (!res.ok) process.exitCode = 1;
  },

  claim(args) {
    const issue = args._[1];
    if (!issue || !args.flags.worker) throw new ArgusError('usage: argus claim <issue> --worker <id> [--assignee <login>]');
    const config = load(args.flags);
    const res = createTracker(config).claim(issue, args.flags.worker, { assignee: args.flags.assignee });
    print(res);
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

  'report-check'(args) {
    const file = args._[1];
    if (!file) throw new ArgusError('usage: argus report-check <report.json>');
    const errs = checkReport(readJson(file));
    print({ ok: errs.length === 0, errors: errs });
    if (errs.length) process.exitCode = 1;
  },
};

export function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) return print(HELP);
  if (!commands[cmd]) throw new ArgusError(`Unknown command: ${cmd}\n\n${HELP}`);
  commands[cmd](args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`argus: ${e.message}\n`);
    process.exit(e instanceof ArgusError ? e.code : 2);
  }
}
