// Pure helpers for review runs: the issue a person writes, which issue runs next, and the harness
// task behind a pull request.
import { parseTaskRef } from './issue.mjs';
import { parseTaskMarker } from './queue.mjs';
import { latestTargets, BRANCH_RE } from './target.mjs';

export const REVIEW_MARKER = '<!-- agent-pr-review -->';
const PR_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/;

const labelNames = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

// Only the text above the marker is the request; below it is the last review.
export const requestText = (body) => String(body ?? '').replace(/\r\n/g, '\n').split(REVIEW_MARKER)[0];

export function parseReviewIssue(body) {
  const text = requestText(body);
  const prs = [];
  for (const m of text.matchAll(/^pr:[ \t]*(\S+)[ \t]*$/gm)) {
    const hit = PR_REF.exec(m[1]) ?? PR_URL.exec(m[1]);
    if (!hit) return { error: `pr must look like owner/repo#123 or a pull request URL: ${m[1]}` };
    if (prs.some((p) => p.repo === hit[1])) return { error: `one pull request per repository: ${hit[1]}` };
    prs.push({ repo: hit[1], number: Number(hit[2]) });
  }
  if (!prs.length) return { error: 'issue body has no "pr: owner/repo#123" line' };
  const context = /^context:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1] ?? null;
  if (context && (context.startsWith('/') || context.split('/').includes('..'))) {
    return { error: `context path must be relative inside the repository: ${context}` };
  }
  return { prs, context };
}

export function selectReview({ issues }) {
  const next = issues
    .map((i) => ({ ...i, labels: labelNames(i.labels) }))
    .filter((i) => i.labels.includes('review') && !i.labels.includes('agent:running'))
    .sort((a, b) => a.number - b.number)[0];
  if (!next) return { issue: null };
  const issue = { number: next.number, title: next.title, body: next.body, labels: next.labels };
  const parsed = parseReviewIssue(next.body);
  return parsed.error
    ? { issue, prs: [], context: null, skip: `bad issue: ${parsed.error}` }
    : { issue, prs: parsed.prs, context: parsed.context, skip: null };
}

// The pull request's own task marker (same-repository pull requests), or the queue issue whose
// READY comment lists it (pull requests in a target repository).
export function planTaskFor({ pr, prBody, issues = [] }) {
  const own = parseTaskMarker(prBody);
  if (own) return own;
  for (const i of issues) {
    if (!latestTargets(i.comments)?.some((p) => p.repo === pr.repo && p.number === pr.number)) continue;
    const ref = parseTaskRef(i.body);
    if (!ref.error) return { plan: ref.plan, task: ref.task, issue: i.number };
  }
  return null;
}

const SHA = /^[0-9a-f]{40}$/;
export const MAX_REVIEW_LINES = 50000;

// prData: one `gh pr view` result per requested pull request, in request order; null when unreadable.
// Head SHAs and base names reach shell steps, so both are checked here.
export function buildReviewSelection({ selection, prData, candidates = [] }) {
  if (!selection.issue || selection.skip) return selection;
  const prs = [];
  for (const [i, want] of selection.prs.entries()) {
    const d = prData[i];
    const name = `${want.repo}#${want.number}`;
    if (!d) return { ...selection, skip: `pull request not readable: ${name}` };
    const base = String(d.baseRefName ?? '');
    if (!SHA.test(String(d.headRefOid)) || !BRANCH_RE.test(base) || base.includes('..') || base.endsWith('.lock')) {
      return { ...selection, skip: `pull request has an unexpected head or base: ${name}` };
    }
    prs.push({
      ...want, url: d.url ?? null, title: d.title ?? '', body: d.body ?? '', headSha: d.headRefOid, baseRef: base,
      lines: (d.additions ?? 0) + (d.deletions ?? 0),
    });
  }
  const lines = prs.reduce((n, p) => n + p.lines, 0);
  if (lines > MAX_REVIEW_LINES) {
    return { ...selection, prs, skip: `pull requests are too large to review here: ${lines} changed lines (limit ${MAX_REVIEW_LINES})` };
  }
  const task = prs.map((p) => planTaskFor({ pr: p, prBody: p.body, issues: candidates })).find(Boolean) ?? null;
  return { ...selection, prs, task, skip: null };
}

// Where each pull request is checked out: the consumer root, the target clone, or one of its
// submodules. Outermost first, so a superproject's submodule update cannot undo a submodule checkout.
export function checkoutPlan({ selection, consumerRepo, target, submodules = [] }) {
  const places = [{ repo: consumerRepo, dir: '.', auth: 'consumer' }];
  if (target) {
    places.push({ repo: target.repo, dir: target.path, auth: 'target' });
    for (const s of submodules) places.push({ repo: s.repo, dir: `${target.path}/${s.path}`, auth: 'target' });
  }
  const plan = [];
  for (const pr of selection.prs) {
    const place = places.find((p) => p.repo.toLowerCase() === pr.repo.toLowerCase());
    if (!place) return { error: `pull request is not in this repository or its target: ${pr.repo}#${pr.number}` };
    plan.push({
      repo: pr.repo, number: pr.number, dir: place.dir, prefix: place.dir === '.' ? '' : `${place.dir}/`, auth: place.auth,
      headSha: pr.headSha, baseRef: pr.baseRef,
    });
  }
  const depth = (p) => (p.dir === '.' ? 0 : p.dir.split('/').length);
  return { plan: plan.sort((a, b) => depth(a) - depth(b)) };
}
