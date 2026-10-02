import { parseTaskRef } from './issue.mjs';

const MARKER_RE = /<!-- agent-task plan=(\S+) task=(\d+) issue=(\d+) -->/;

export function taskMarker({ plan, task, issue }) {
  return `<!-- agent-task plan=${plan} task=${task} issue=${issue} -->`;
}

export function parseTaskMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ''));
  return m ? { plan: m[1], task: Number(m[2]), issue: Number(m[3]) } : null;
}

const labelNames = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

export function selectNext({ issues, prs, defaultBranch }) {
  const all = issues.map((i) => ({ ...i, labels: labelNames(i.labels), ref: parseTaskRef(i.body) }));
  const queued = all.filter((i) => (i.labels.includes('agent') || i.labels.includes('agent:waiting')) && !i.labels.includes('agent:running'));
  if (queued.length === 0) return { issue: null };

  queued.sort((a, b) => {
    const aBad = Boolean(a.ref.error);
    const bBad = Boolean(b.ref.error);
    if (aBad !== bBad) return aBad ? -1 : 1;
    if (aBad) return a.number - b.number;
    return a.ref.plan.localeCompare(b.ref.plan) || a.ref.task - b.ref.task || a.number - b.number;
  });

  const next = queued[0];
  const issue = { number: next.number, title: next.title, body: next.body, labels: next.labels };
  if (next.ref.error) {
    return { issue, plan: null, task: null, base: defaultBranch, skip: `bad task reference: ${next.ref.error}` };
  }

  const { plan, task } = next.ref;
  const upstream = all
    .filter((i) => i.labels.includes('agent:blocked') && !i.ref.error && i.ref.plan === plan && i.ref.task < task)
    .sort((a, b) => a.ref.task - b.ref.task)[0];
  if (upstream) {
    return { issue, plan, task, base: defaultBranch, skip: `upstream task ${upstream.ref.task} blocked (#${upstream.number})` };
  }

  // Only the harness's own same-repo branches may become a base: anyone can
  // open a PR carrying a marker, and the base name reaches shell steps.
  const parent = prs
    .filter((p) => !p.isCrossRepository && /^agent\/issue-\d+$/.test(p.headRefName))
    .map((p) => ({ head: p.headRefName, marker: parseTaskMarker(p.body) }))
    .filter((p) => p.marker && p.marker.plan === plan && p.marker.task < task)
    .sort((a, b) => b.marker.task - a.marker.task)[0];

  return { issue, plan, task, base: parent ? parent.head : defaultBranch, skip: null };
}
