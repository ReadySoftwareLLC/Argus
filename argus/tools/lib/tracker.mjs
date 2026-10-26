// GitHub issues as the work tracker, via the `gh` CLI. The runner is injectable so tests never touch the network.
import { execFileSync } from 'node:child_process';
import { ArgusError } from './util.mjs';

export const STATES = ['ready', 'claimed', 'in-progress', 'in-review', 'blocked'];
export const CLAIM_MARKER = 'argus-claim';

/** Default runner: gh with JSON out. Throws ArgusError with stderr. */
export function ghRunner(args, { input } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    throw new ArgusError(`gh ${args.slice(0, 3).join(' ')} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
}

export function labelFor(config, state) {
  return `${config.tracker.label_prefix ?? 'argus:'}${state}`;
}

/** Create (or update, idempotently) the state labels and the epic label in the tracker repo. */
export function ensureLabels(config, run = ghRunner) {
  const names = [...STATES.map((s) => labelFor(config, s)), config.tracker.epic_label ?? 'epic'];
  for (const n of names) run(['label', 'create', n, '--repo', config.tracker.repo, '--force']);
  return names;
}

export function claimBody(workerId, now = new Date()) {
  return `${CLAIM_MARKER}:${workerId}:${now.toISOString()}`;
}

/** Parse claim comments out of an issue's comment list. */
export function parseClaims(comments) {
  const re = new RegExp(`^${CLAIM_MARKER}:([^:\\s]+):(\\S+)\\s*$`);
  return comments
    .map((c) => {
      const m = re.exec((c.body ?? '').trim());
      return m ? { worker: m[1], at: m[2], createdAt: c.createdAt ?? c.created_at ?? m[2], id: c.id ?? null } : null;
    })
    .filter(Boolean);
}

/** Earliest claim wins. Ties on timestamp break by comment id, then worker id. Returns the claim or null. */
export function winningClaim(comments) {
  const claims = parseClaims(comments);
  if (!claims.length) return null;
  return claims.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || String(a.id ?? '').localeCompare(String(b.id ?? '')) || a.worker.localeCompare(b.worker)
  )[0];
}

export function createTracker(config, run = ghRunner) {
  const repo = config.tracker.repo;
  const issueJson = (n, fields) => JSON.parse(run(['issue', 'view', String(n), '--repo', repo, '--json', fields]));

  return {
    /** Live fetch. Callers must use this, not status.md, to decide anything. */
    getIssue(n) {
      return issueJson(n, 'number,title,state,labels,assignees,comments,url,body');
    },

    listStories({ label } = {}) {
      const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,labels,assignees,url'];
      if (label) args.push('--label', label);
      return JSON.parse(run(args));
    },

    setState(n, state) {
      if (!STATES.includes(state)) throw new ArgusError(`Unknown state ${state}`);
      const issue = this.getIssue(n);
      const prefix = config.tracker.label_prefix ?? 'argus:';
      const stale = issue.labels.map((l) => l.name).filter((l) => l.startsWith(prefix) && l !== labelFor(config, state));
      const args = ['issue', 'edit', String(n), '--repo', repo, '--add-label', labelFor(config, state)];
      for (const s of stale) args.push('--remove-label', s);
      run(args);
    },

    /**
     * Claim protocol (GitHub has no atomic claim):
     * 1. Re-read: refuse if already closed or someone else holds the earliest claim.
     * 2. Post a claim comment, add the claimed label.
     * 3. Re-read comments. Earliest claim wins. Only the winner assigns itself.
     */
    claim(n, workerId, { assignee, now = new Date() } = {}) {
      const before = this.getIssue(n);
      if (before.state && before.state.toLowerCase() !== 'open') return { won: false, reason: 'issue is not open' };
      const existing = winningClaim(before.comments ?? []);
      if (existing && existing.worker !== workerId) return { won: false, reason: `already claimed by ${existing.worker}`, holder: existing.worker };
      if (!existing) run(['issue', 'comment', String(n), '--repo', repo, '--body', claimBody(workerId, now)]);
      const after = this.getIssue(n);
      const winner = winningClaim(after.comments ?? []);
      if (!winner || winner.worker !== workerId) return { won: false, reason: `lost claim race to ${winner?.worker ?? 'unknown'}`, holder: winner?.worker ?? null };
      const args = ['issue', 'edit', String(n), '--repo', repo, '--add-label', labelFor(config, 'claimed')];
      if (assignee) args.push('--add-assignee', assignee);
      run(args);
      return { won: true };
    },
  };
}
