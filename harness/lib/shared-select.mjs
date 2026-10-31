import { selectNext } from './queue.mjs';
import { issueToClose } from './merged.mjs';

// A task that has carried `agent:running` for longer than a run can last (the run job's limit
// is 3 hours) is a crashed run.
export const STALE_MS = 4 * 60 * 60 * 1000;

const names = (i) => i.labels.map((l) => l.name);
const has = (i, name) => names(i).includes(name);
const queued = (i, resume) => !has(i, 'agent:running') && (has(i, 'agent') || (resume && has(i, 'agent:waiting')));

export function runningState(issues, now) {
  const running = issues.filter((i) => has(i, 'agent:running'));
  const stale = running.filter((i) => now - Date.parse(i.updatedAt) > STALE_MS).map((i) => i.number);
  return { busy: running.length > stale.length, stale };
}

export async function loadProject(client, repo) {
  const defaultBranch = await client.defaultBranch(repo);
  const [issues, prs, configText] = await Promise.all([
    client.openIssues(repo),
    client.openPrs(repo),
    client.fileContent(repo, 'agent.config.json', defaultBranch),
  ]);
  const ready = [];
  for (const i of issues.filter((x) => has(x, 'agent:ready'))) {
    ready.push({ number: i.number, body: i.body, comments: await client.comments(repo, i.number) });
  }
  return { defaultBranch, issues, prs, ready, configText };
}

// Stacked tasks merged into their parent branch never close their issue on their own.
export async function closeMergedFor({ repo, client, issues }) {
  const open = new Set(issues.map((i) => i.number));
  const closed = [];
  for (const pull_request of await client.closedMergedPrs(repo)) {
    const n = issueToClose({ pull_request });
    if (n !== null && open.has(n)) {
      await client.closeIssue(repo, n);
      closed.push(n);
    }
  }
  return closed;
}

// At most one task per project and at most `maxParallel` projects. A project with a live
// running task is skipped, so two runs of one project never overlap.
export async function selectAcrossProjects({ projects, maxParallel, load, now, resume = false }) {
  const chosen = [];
  const released = [];
  let more = false;
  let failed = 0;
  for (const [position, project] of projects.entries()) {
    // One project's API error must not stop the others.
    let data;
    try {
      data = await load(project);
    } catch {
      failed += 1;
      continue;
    }
    if (!data) continue;
    const { busy, stale } = runningState(data.issues, now);
    for (const issue of stale) released.push({ project, issue });
    const staleSet = new Set(stale);
    // A released task counts as blocked and is no longer queued, so later tasks of its plan
    // wait behind it and it is not run in the same round it was released.
    const issues = data.issues.map((i) => (staleSet.has(i.number)
      ? { ...i, labels: [...i.labels.filter((l) => !['agent:running', 'agent', 'agent:waiting'].includes(l.name)), { name: 'agent:blocked' }] }
      : i));
    // A busy project is left alone and does not ask for another round: it would only be
    // found busy again. Its own running round continues its queue.
    if (busy) continue;
    const waiting = issues.filter((i) => queued(i, resume)).length;
    if (chosen.length >= maxParallel) {
      more ||= waiting > 0;
      continue;
    }
    const selection = selectNext({ issues, prs: data.prs, defaultBranch: data.defaultBranch, ready: data.ready });
    if (!selection.issue) continue;
    // A task paused by a usage limit keeps its place: nothing runs ahead of it unless the
    // scheduled run is resuming it.
    if (!resume && has(issues.find((i) => i.number === selection.issue.number), 'agent:waiting')) continue;
    chosen.push({ position, project, selection, defaultBranch: data.defaultBranch, data });
    more ||= waiting > 1;
  }
  return { chosen, released, more, failed };
}
