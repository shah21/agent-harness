import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_MARKER, requestText, parseReviewIssue, selectReview, planTaskFor } from '../harness/lib/pr-review.mjs';
import { taskMarker } from '../harness/lib/queue.mjs';
import { targetsMarker } from '../harness/lib/target.mjs';

test('the request is the text above the marker', () => {
  assert.equal(REVIEW_MARKER, '<!-- agent-pr-review -->');
  assert.equal(requestText(`pr: o/r#1\r\nplease look\n${REVIEW_MARKER}\n## old review`), 'pr: o/r#1\nplease look\n');
  assert.equal(requestText(null), '');
});

test('parses pr lines and an optional context line', () => {
  assert.deepEqual(parseReviewIssue('Check this\npr: o/super#12\npr: https://github.com/o/sub/pull/3\ncontext: docs/notes.md\n'), {
    prs: [{ repo: 'o/super', number: 12 }, { repo: 'o/sub', number: 3 }],
    context: 'docs/notes.md',
  });
  assert.deepEqual(parseReviewIssue(`pr: o/r#1\n${REVIEW_MARKER}\npr: o/other#9\n`), { prs: [{ repo: 'o/r', number: 1 }], context: null });
});

test('rejects bad issues', () => {
  assert.deepEqual(parseReviewIssue('no lines'), { error: 'issue body has no "pr: owner/repo#123" line' });
  assert.deepEqual(parseReviewIssue('pr: #12'), { error: 'pr must look like owner/repo#123 or a pull request URL: #12' });
  assert.deepEqual(parseReviewIssue('pr: o/r#1\npr: o/r#2'), { error: 'one pull request per repository: o/r' });
  assert.deepEqual(parseReviewIssue('pr: o/r#1\ncontext: ../x'), { error: 'context path must be relative inside the repository: ../x' });
});

test('selects the oldest queued review issue', () => {
  const issues = [
    { number: 9, title: 'b', body: 'pr: o/r#2', labels: [{ name: 'review' }] },
    { number: 4, title: 'a', body: 'pr: o/r#1', labels: [{ name: 'review' }, { name: 'agent:running' }] },
    { number: 6, title: 'c', body: 'pr: o/r#3', labels: ['review'] },
    { number: 2, title: 'd', body: 'pr: o/r#4', labels: ['debug'] },
  ];
  assert.deepEqual(selectReview({ issues }), {
    issue: { number: 6, title: 'c', body: 'pr: o/r#3', labels: ['review'] }, prs: [{ repo: 'o/r', number: 3 }], context: null, skip: null,
  });
  assert.deepEqual(selectReview({ issues: [] }), { issue: null });
  assert.equal(selectReview({ issues: [{ number: 1, title: 'x', body: 'nothing', labels: ['review'] }] }).skip,
    'bad issue: issue body has no "pr: owner/repo#123" line');
});

test('finds the harness task behind a pull request', () => {
  const own = planTaskFor({ pr: { repo: 'o/r', number: 5 }, prBody: `${taskMarker({ plan: 'docs/p.md', task: 3, issue: 41 })}\nCloses #41`, issues: [] });
  assert.deepEqual(own, { plan: 'docs/p.md', task: 3, issue: 41 });

  const ready = `✅ **READY_FOR_QA** — \`https://github.com/o/super/pull/12\`\n\n${targetsMarker([
    { repo: 'o/super', number: 12, branch: 'fix/x', base: 'main', role: 'super' },
  ])}`;
  const issues = [
    { number: 50, body: 'plan: docs/other.md\ntask: 1', comments: [{ body: 'unrelated' }] },
    { number: 51, body: 'plan: docs/q.md\ntask: 2', comments: [{ body: ready }] },
  ];
  assert.deepEqual(planTaskFor({ pr: { repo: 'o/super', number: 12 }, prBody: 'by hand', issues }), { plan: 'docs/q.md', task: 2, issue: 51 });
  assert.equal(planTaskFor({ pr: { repo: 'o/super', number: 13 }, prBody: '', issues }), null);
});
