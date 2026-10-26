// Story graph validation and wave planning. Deterministic: the LLM is not trusted to order work.
//
// plan.json: { "stories": [ { "id": "12", "repo": "api", "depends_on": ["10"], "files": ["src/a.js", "src/b/**"] } ] }
// Output waves run serially. Stories inside one wave run concurrently, capped by maxConcurrent.
import { ArgusError } from './util.mjs';

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = esc.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`);
}

/** True when two path patterns could touch the same file. Conservative for globs. */
export function patternsOverlap(a, b) {
  if (a === b) return true;
  const aGlob = /[*?]/.test(a);
  const bGlob = /[*?]/.test(b);
  if (!aGlob && !bGlob) return false;
  if (!aGlob) return globToRegex(b).test(a);
  if (!bGlob) return globToRegex(a).test(b);
  const stem = (g) => g.split(/[*?]/)[0];
  const sa = stem(a);
  const sb = stem(b);
  return sa.startsWith(sb) || sb.startsWith(sa);
}

export function validateStories(stories) {
  const errors = [];
  const ids = new Set();
  for (const s of stories) {
    if (!s.id) errors.push('story without id');
    else if (ids.has(String(s.id))) errors.push(`duplicate story id: ${s.id}`);
    else ids.add(String(s.id));
  }
  for (const s of stories) {
    for (const d of s.depends_on ?? []) {
      if (!ids.has(String(d))) errors.push(`story ${s.id} depends on unknown story ${d}`);
      if (String(d) === String(s.id)) errors.push(`story ${s.id} depends on itself`);
    }
  }
  return errors;
}

/** Kahn levels. Returns { waves: string[][], cycle: string[]|null }. */
export function topoWaves(stories) {
  const indeg = new Map();
  const out = new Map();
  for (const s of stories) {
    indeg.set(String(s.id), 0);
    out.set(String(s.id), []);
  }
  for (const s of stories) {
    for (const d of s.depends_on ?? []) {
      indeg.set(String(s.id), indeg.get(String(s.id)) + 1);
      out.get(String(d))?.push(String(s.id));
    }
  }
  const waves = [];
  let ready = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (ready.length) {
    waves.push(ready.sort());
    seen += ready.length;
    const next = [];
    for (const id of ready) {
      for (const m of out.get(id)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    }
    ready = next;
  }
  if (seen !== stories.length) {
    const cycle = [...indeg].filter(([, n]) => n > 0).map(([id]) => id).sort();
    return { waves, cycle };
  }
  return { waves, cycle: null };
}

/**
 * Build an execution plan.
 * Within a wave, stories whose files overlap are moved to later sub-waves (serialized).
 * Each sub-wave is chunked to maxConcurrent.
 * Returns { ok, errors, waves: [{ wave, stories: [ids] }], serialized: [{ story, because, overlaps }] }.
 */
export function buildPlan(stories, { maxConcurrent = 3, repos } = {}) {
  const errors = validateStories(stories);
  if (repos) {
    for (const s of stories) if (s.repo && !repos.includes(s.repo)) errors.push(`story ${s.id} uses unknown repo ${s.repo}`);
  }
  if (errors.length) return { ok: false, errors, waves: [], serialized: [] };
  const { waves, cycle } = topoWaves(stories);
  if (cycle) return { ok: false, errors: [`dependency cycle among: ${cycle.join(', ')}`], waves: [], serialized: [] };

  const byId = new Map(stories.map((s) => [String(s.id), s]));
  const serialized = [];
  const out = [];
  for (const wave of waves) {
    const groups = []; // each group is a set of non-overlapping stories
    for (const id of wave) {
      const s = byId.get(id);
      const home = groups.find((g) => !g.some((other) => storiesOverlap(byId.get(other), s)));
      if (home) {
        home.push(id);
      } else {
        if (groups.length) {
          const first = groups.flat().find((other) => storiesOverlap(byId.get(other), s));
          serialized.push({ story: id, because: first, overlaps: overlapFiles(byId.get(first), s) });
        }
        groups.push([id]);
      }
    }
    for (const g of groups) {
      for (let i = 0; i < g.length; i += maxConcurrent) out.push(g.slice(i, i + maxConcurrent));
    }
  }
  return { ok: true, errors: [], waves: out.map((stories, i) => ({ wave: i + 1, stories })), serialized };
}

function storiesOverlap(a, b) {
  return overlapFiles(a, b).length > 0;
}

function overlapFiles(a, b) {
  const hits = [];
  for (const fa of a.files ?? []) {
    for (const fb of b.files ?? []) {
      if (patternsOverlap(fa, fb)) hits.push(fa === fb ? fa : `${fa} ~ ${fb}`);
    }
  }
  return hits;
}

/**
 * Manual-mode launch plan: one line per story, grouped by wave.
 * promptFor(id) returns the prompt file path. Used when the host cannot spawn workers.
 */
export function launchPlan(plan, promptFor) {
  const lines = [];
  for (const w of plan.waves) {
    const par = w.stories.length > 1 ? `start these ${w.stories.length} sessions together` : 'start this session';
    lines.push(`Wave ${w.wave}: ${par}. Wait for all to open a PR before the next wave.`);
    for (const id of w.stories) lines.push(`  - story ${id}: new worker session, prompt file ${promptFor(id)}`);
  }
  return lines.join('\n');
}
