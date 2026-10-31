import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjects } from './projects.mjs';
import { parseTokenMap, resolveToken, makeProbe } from './tokens.mjs';
import { githubClient } from './github.mjs';
import { loadProject, closeMergedFor, selectAcrossProjects } from './shared-select.mjs';
import { targetsToCheck } from './queue.mjs';
import { loadConfig } from './config.mjs';
import { findTaskHeading } from './issue.mjs';

// The same expression `target-info` uses for the target checkout ref.
const targetRef = (selection) => selection.targets?.superBranch ?? selection.targetBase ?? '';

// A task whose target-repository pull request merged is done; the per-repository workflow
// that used to close it does not run in a project that has moved to the runner.
async function closeMergedTargets({ project, data, client, tokenMap, probe, fetchImpl }) {
  const closed = [];
  if (!project.target) return closed;
  const listed = new Set([project.target.repo, ...project.target.allow]);
  for (const t of targetsToCheck(data.ready).filter((x) => listed.has(x.repo))) {
    const list = tokenMap[project.target.tokenOwner];
    const r = list ? await resolveToken({ repo: t.repo, tokens: list, needsWrite: false, probe }) : null;
    if (!r) continue;
    if (await githubClient({ token: list[r.index], fetchImpl }).prMerged(t.repo, t.number)) {
      await client.closeIssue(project.repo, t.issue);
      closed.push(t.issue);
    }
  }
  return closed;
}

export async function runSharedSelect({ projectsText, tokensText, outDir, fetchImpl = fetch, now = Date.now(), resume = false }) {
  const { projects, maxParallel } = parseProjects(projectsText);
  const tokenMap = parseTokenMap(tokensText);
  const probe = makeProbe(fetchImpl);

  const resolved = new Map();
  const clients = new Map();
  const usable = [];
  let skippedNoToken = 0;
  let failed = 0;
  for (const p of projects) {
    const list = tokenMap[p.tokenOwner];
    let r = null;
    try {
      r = list ? await resolveToken({ repo: p.repo, tokens: list, needsWrite: true, probe }) : null;
    } catch {
      failed += 1;
      continue;
    }
    if (!r) {
      skippedNoToken += 1;
      continue;
    }
    resolved.set(p.repo, { tokenOwner: p.tokenOwner, tokenIndex: r.index, tokenKind: r.kind });
    clients.set(p.repo, githubClient({ token: list[r.index], fetchImpl }));
    usable.push(p);
  }

  const load = async (p) => {
    const client = clients.get(p.repo);
    const data = await loadProject(client, p.repo);
    const closed = new Set(await closeMergedFor({ repo: p.repo, client, issues: data.issues }));
    for (const n of await closeMergedTargets({ project: p, data, client, tokenMap, probe, fetchImpl })) closed.add(n);
    return { ...data, issues: data.issues.filter((i) => !closed.has(i.number)) };
  };
  const picked = await selectAcrossProjects({ projects: usable, maxParallel, load, now, resume });
  const { chosen, released, more } = picked;
  failed += picked.failed;

  for (const { project, issue } of released) {
    try {
      const client = clients.get(project.repo);
      await client.setLabels(project.repo, issue, { remove: ['agent:running', 'agent', 'agent:waiting'], add: ['agent:blocked'] });
      await client.comment(project.repo, issue, '⛔ **BLOCKED** (runner)\n\n- the previous run did not finish (no result was recorded)\n\nTo retry: remove `agent:blocked` and add `agent`.');
    } catch {
      failed += 1;
    }
  }

  const entries = [];
  for (const c of chosen) {
    const { repo } = c.project;
    try {
      await clients.get(repo).setLabels(repo, c.selection.issue.number, { remove: ['agent', 'agent:waiting'], add: ['agent:running'] });
    } catch {
      failed += 1;
      continue;
    }
    let target = null;
    try {
      const t = c.data.configText ? loadConfig(c.data.configText).target : null;
      if (t) {
        // The project's own config may only choose the target the owner listed. It never names a
        // repository to clone, and an unlisted one is not even probed.
        const listed = c.project.target;
        if (!listed || t.repo !== listed.repo) {
          target = { error: 'target not allowed' };
        } else {
          const list = tokenMap[listed.tokenOwner];
          const r = list ? await resolveToken({ repo: t.repo, tokens: list, needsWrite: true, probe }) : null;
          target = r
            ? {
              repo: t.repo, path: t.path, ref: targetRef(c.selection), tokenOwner: listed.tokenOwner, tokenIndex: r.index, tokenKind: r.kind,
              allow: listed.allow, branchTemplate: t.branch, branchPrefixes: listed.branchPrefixes,
            }
            : { error: 'no usable token' };
        }
      }
    } catch {
      // an invalid config is reported by the run itself
    }
    // The task title names the target branch, so it is read here, by a trusted job, from the plan
    // at the selection's base: through the API, so a plan that is a link yields no content.
    let taskTitle = null;
    try {
      if (!c.selection.skip && c.selection.plan) {
        const planText = await clients.get(repo).fileContent(repo, c.selection.plan, c.selection.base);
        taskTitle = planText ? findTaskHeading(planText, c.selection.task) : null;
      }
    } catch {
      taskTitle = null;
    }
    entries.push({ index: entries.length, repo, ...resolved.get(repo), defaultBranch: c.defaultBranch, taskTitle, selection: c.selection, target });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'selections.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return { count: entries.length, more, skippedNoToken, failed };
}
