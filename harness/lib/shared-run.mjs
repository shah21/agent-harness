import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjects } from './projects.mjs';
import { parseTokenMap, resolveToken, makeProbe } from './tokens.mjs';
import { githubClient } from './github.mjs';
import { loadProject, closeMergedFor, selectAcrossProjects } from './shared-select.mjs';
import { loadConfig } from './config.mjs';

// The same expression `target-info` uses for the target checkout ref.
const targetRef = (selection) => selection.targets?.superBranch ?? selection.targetBase ?? '';

export async function runSharedSelect({ projectsText, tokensText, outDir, fetchImpl = fetch, now = Date.now(), resume = false }) {
  const { projects, maxParallel } = parseProjects(projectsText);
  const tokenMap = parseTokenMap(tokensText);
  const probe = makeProbe(fetchImpl);

  const resolved = new Map();
  const clients = new Map();
  const usable = [];
  let skippedNoToken = 0;
  for (const p of projects) {
    const list = tokenMap[p.tokenOwner];
    const r = list ? await resolveToken({ repo: p.repo, tokens: list, needsWrite: true, probe }) : null;
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
    return { ...data, issues: data.issues.filter((i) => !closed.has(i.number)) };
  };
  const { chosen, released, more } = await selectAcrossProjects({ projects: usable, maxParallel, load, now, resume });

  for (const { project, issue } of released) {
    const client = clients.get(project.repo);
    await client.setLabels(project.repo, issue, { remove: ['agent:running'], add: ['agent:blocked'] });
    await client.comment(project.repo, issue, '⛔ **BLOCKED** (runner)\n\n- the previous run did not finish (no result was recorded)\n\nTo retry: remove `agent:blocked` and add `agent`.');
  }

  const entries = [];
  for (const [index, c] of chosen.entries()) {
    const { repo } = c.project;
    const client = clients.get(repo);
    await client.setLabels(repo, c.selection.issue.number, { remove: ['agent', 'agent:waiting'], add: ['agent:running'] });
    let target = null;
    try {
      const t = c.data.configText ? loadConfig(c.data.configText).target : null;
      if (t) {
        const owner = c.project.targetTokenOwner ?? t.repo.split('/')[0];
        const list = tokenMap[owner];
        const r = list ? await resolveToken({ repo: t.repo, tokens: list, needsWrite: true, probe }) : null;
        const base = { repo: t.repo, path: t.path, ref: targetRef(c.selection) };
        target = r ? { ...base, tokenOwner: owner, tokenIndex: r.index, tokenKind: r.kind } : { ...base, error: 'no usable token' };
      }
    } catch {
      // an invalid config is reported by the run itself
    }
    entries.push({ index, repo, ...resolved.get(repo), defaultBranch: c.defaultBranch, selection: c.selection, target });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'selections.json'), `${JSON.stringify(entries, null, 2)}\n`);
  return { count: entries.length, more, skippedNoToken };
}
