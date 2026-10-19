// Pure helpers for review runs: the issue a person writes, which issue runs next, and the harness
// task behind a pull request.
import { parseTaskRef } from './issue.mjs';
import { parseTaskMarker } from './queue.mjs';
import { latestTargets } from './target.mjs';

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
