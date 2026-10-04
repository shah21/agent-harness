import { parseTaskMarker } from './queue.mjs';

// Merging a stack of agent PRs by hand is easy to get wrong: each PR must be retargeted
// to the default branch before it merges, and branches must not be deleted until the
// whole stack is in (GitHub closes PRs whose base branch is deleted, and they cannot be
// reopened). This plans and performs that order, and stops at the first problem.

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

export function selectStacks(prs) {
  const byPlan = new Map();
  for (const p of prs) {
    const branch = /^agent\/issue-(\d+)$/.exec(p.headRefName ?? '');
    const marker = parseTaskMarker(p.body);
    if (!branch || !marker || marker.issue !== Number(branch[1])) continue;
    const entry = {
      number: p.number, title: p.title, branch: p.headRefName, base: p.baseRefName,
      task: marker.task, isDraft: Boolean(p.isDraft),
    };
    byPlan.set(marker.plan, [...(byPlan.get(marker.plan) ?? []), entry]);
  }
  return [...byPlan]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([plan, list]) => ({ plan, prs: list.sort((a, b) => a.task - b.task) }));
}

export function checksState(rollup) {
  if (!rollup?.length) return 'none';
  let pending = false;
  for (const c of rollup) {
    if (c.state) {
      if (c.state === 'FAILURE' || c.state === 'ERROR') return 'failing';
      if (c.state === 'PENDING' || c.state === 'EXPECTED') pending = true;
      continue;
    }
    if (c.status && c.status !== 'COMPLETED') {
      pending = true;
      continue;
    }
    if (FAILING_CONCLUSIONS.has(c.conclusion)) return 'failing';
  }
  return pending ? 'pending' : 'passing';
}

export function describeStacks(stacks, defaultBranch) {
  return stacks.flatMap((s) => [
    s.plan,
    ...s.prs.map((p) => {
      const move = p.base === defaultBranch ? `base ${p.base}` : `retarget ${p.base} → ${defaultBranch}`;
      return `  #${p.number}  ${p.title}  ${p.branch}  ${move}${p.isDraft ? '  (draft)' : ''}`;
    }),
  ]);
}

export async function mergeStacks({
  repo, defaultBranch, yes = false, run, sleep, log = console.log, pollAttempts = 24, pollIntervalMs = 5000,
}) {
  const prs = JSON.parse(await run([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title,headRefName,baseRefName,body,isDraft',
  ]));
  const stacks = selectStacks(prs);
  if (!stacks.length) {
    log('no open agent PRs');
    return { ok: true, merged: [] };
  }
  for (const line of describeStacks(stacks, defaultBranch)) log(line);
  if (!yes) {
    log('Dry run: nothing changed. Re-run with --yes to merge in this order.');
    return { ok: true, merged: [] };
  }

  async function waitReady(p) {
    let waiting = 'mergeability still being computed';
    for (let i = 0; i < pollAttempts; i++) {
      const v = JSON.parse(await run(['pr', 'view', String(p.number), '--repo', repo, '--json', 'mergeable,state,isDraft,statusCheckRollup']));
      if (v.state && v.state !== 'OPEN') return `is ${String(v.state).toLowerCase()}`;
      if (v.isDraft) return 'is a draft';
      if (v.mergeable === 'CONFLICTING') return 'has a merge conflict';
      const checks = checksState(v.statusCheckRollup);
      if (checks === 'failing') return 'has failing checks';
      if (v.mergeable === 'MERGEABLE' && checks !== 'pending') return null;
      waiting = v.mergeable === 'MERGEABLE' ? 'checks are still running' : 'mergeability still being computed';
      await sleep(pollIntervalMs);
    }
    return `gave up waiting: ${waiting}`;
  }

  const merged = [];
  const branches = [];
  for (const stack of stacks) {
    for (const p of stack.prs) {
      let problem = p.isDraft ? 'is a draft' : null;
      if (!problem) {
        if (p.base !== defaultBranch) await run(['pr', 'edit', String(p.number), '--repo', repo, '--base', defaultBranch]);
        problem = await waitReady(p);
      }
      if (problem) {
        const reason = `#${p.number} ${problem}`;
        log(`Stopped: ${reason}. Merged so far: ${merged.map((n) => `#${n}`).join(', ') || 'none'}. No branches were deleted.`);
        return { ok: false, merged, stoppedAt: p.number, reason };
      }
      await run(['pr', 'merge', String(p.number), '--repo', repo, '--merge']);
      log(`Merged #${p.number} (${p.title})`);
      merged.push(p.number);
      branches.push(p.branch);
    }
  }

  for (const branch of branches) {
    try {
      await run(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`]);
    } catch (e) {
      log(`Could not delete ${branch}: ${e.message}`);
    }
  }
  log(`Done: ${merged.length} PR(s) merged, ${branches.length} branch(es) deleted.`);
  return { ok: true, merged };
}
