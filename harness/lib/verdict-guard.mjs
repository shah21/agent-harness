// The publish job holds write tokens and reads output written by the run job, which runs
// project code and an agent. Nothing in that output may decide where the tokens are used, so
// every field that reaches git or gh is taken from the trusted selection or checked against it.
// Rejections carry fixed text: they are printed where logs are public.
import { join } from 'node:path';
import { BRANCH_RE, renderBranch } from './target.mjs';

const OUTCOMES = new Set(['READY_FOR_QA', 'BLOCKED', 'WAITING']);
const SAFE_PREFIX = /^(?:agent|feat|fix|chore|refactor|test|docs|perf)\/[a-z0-9]/;
const SHA = /^[0-9a-f]{40}$/;
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.bundle$/;
const ROLES = new Set(['sub', 'super']);

export const REJECTIONS = {
  shape: 'the run output did not have the expected shape',
  task: 'the run output did not match its task',
  repo: 'the run output named a repository that is not allowed',
  branch: 'the run output named an unsafe branch',
  bundle: 'the run output named an unsafe bundle',
};

const isString = (v, max = 200_000) => typeof v === 'string' && v.length <= max;

export function guardVerdict({ verdict, entry, bundleDir, fileExists }) {
  const reject = (key) => ({ ok: false, reason: REJECTIONS[key] });
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict) || !OUTCOMES.has(verdict.outcome)) return reject('shape');

  const sel = entry.selection;
  const issue = sel.issue.number;
  const sameOrAbsent = (got, want) => got === undefined || got === null || got === (want ?? null);
  if (verdict.issue !== issue
    || verdict.branch !== `agent/issue-${issue}`
    || verdict.baseBranch !== sel.base
    || !sameOrAbsent(verdict.task, sel.task)
    || !sameOrAbsent(verdict.plan, sel.plan)) return reject('task');

  const raw = verdict.targets ?? [];
  if (!Array.isArray(raw)) return reject('shape');
  const used = [];
  const configured = entry.target && !entry.target.error ? entry.target : null;

  let expectedBranch = null;
  if (configured) {
    try {
      expectedBranch = renderBranch(configured.branchTemplate, { issue, task: sel.task, taskTitle: entry.taskTitle });
    } catch {
      return reject('branch');
    }
    const prefixes = configured.branchPrefixes ?? [];
    if (!SAFE_PREFIX.test(expectedBranch) && !prefixes.some((p) => typeof p === 'string' && p !== '' && expectedBranch.startsWith(p))) {
      return reject('branch');
    }
  }
  const allowedRepos = new Set(configured ? [configured.repo, ...(configured.allow ?? [])] : []);
  const knownBases = new Set([sel.targetBase, ...Object.values(sel.targets?.bases ?? {})].filter(Boolean));

  for (const t of raw) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return reject('shape');
    if (!Number.isInteger(t.commits) || t.commits <= 0) continue; // the publisher ignores these
    if (!isString(t.repo, 200) || !allowedRepos.has(t.repo)) return reject('repo');
    if (!ROLES.has(t.role)) return reject('shape');
    if (t.branch !== expectedBranch || !BRANCH_RE.test(t.branch)) return reject('branch');
    if (t.base !== null && t.base !== undefined && (!BRANCH_RE.test(String(t.base)) || !knownBases.has(t.base))) return reject('branch');
    if (!isString(t.baseSha, 40) || !SHA.test(t.baseSha)) return reject('bundle');
    if (!isString(t.bundle, 200) || !BUNDLE.test(t.bundle) || !fileExists(join(bundleDir, t.bundle))) return reject('bundle');
    if (!isString(t.prTitle) || !isString(t.prBody)) return reject('shape');
    used.push(t);
  }
  if (used.filter((t) => t.role === 'super').length > 1) return reject('shape');

  const out = JSON.parse(JSON.stringify(verdict));
  if (Array.isArray(verdict.targets)) out.targets = JSON.parse(JSON.stringify(used));
  return { ok: true, verdict: out };
}
