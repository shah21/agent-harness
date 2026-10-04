import { parseTaskMarker } from './queue.mjs';

// The task issue a merged agent PR should close, or null. GitHub's "Closes #n" only
// fires when the PR merges into the default branch, so a stacked PR merged into its
// parent branch would leave its issue open. Everything must agree before an issue is
// closed: merged, an agent/issue-<n> branch in this repo (not a fork), and a marker
// naming the same issue.
export function issueToClose(event) {
  const pr = event?.pull_request;
  if (!pr || pr.merged !== true) return null;
  const branch = /^agent\/issue-(\d+)$/.exec(pr.head?.ref ?? '');
  if (!branch) return null;
  const headRepo = pr.head?.repo?.full_name;
  if (!headRepo || headRepo !== pr.base?.repo?.full_name) return null;
  const marker = parseTaskMarker(pr.body);
  const issue = Number(branch[1]);
  return marker && marker.issue === issue ? issue : null;
}
