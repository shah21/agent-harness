import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStacks, checksState, describeStacks, mergeStacks } from '../harness/lib/merge-stack.mjs';
import { taskMarker } from '../harness/lib/queue.mjs';

const pr = (number, task, over = {}) => ({
  number, title: `Task ${task}`, isDraft: false,
  headRefName: `agent/issue-${number + 100}`,
  baseRefName: 'main',
  body: `${taskMarker({ plan: 'docs/p.md', task, issue: number + 100 })}\nCloses #${number + 100}`,
  ...over,
});

test('selectStacks keeps only well-formed agent PRs and orders each plan by task', () => {
  const stacks = selectStacks([
    pr(3, 3), pr(1, 1), pr(2, 2),
    { number: 9, title: 'human PR', headRefName: 'feat/x', baseRefName: 'main', body: 'hi' },
    pr(8, 1, { headRefName: 'agent/issue-999' }),
    pr(7, 4, { body: 'no marker' }),
    pr(5, 1, { body: `${taskMarker({ plan: 'docs/other.md', task: 1, issue: 105 })}` }),
  ]);
  assert.deepEqual(stacks.map((s) => [s.plan, s.prs.map((p) => p.number)]), [
    ['docs/other.md', [5]],
    ['docs/p.md', [1, 2, 3]],
  ]);
});

test('checksState reads GitHub status rollups', () => {
  assert.equal(checksState([]), 'none');
  assert.equal(checksState(null), 'none');
  assert.equal(checksState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'passing');
  assert.equal(checksState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failing');
  assert.equal(checksState([{ status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(checksState([{ state: 'FAILURE' }]), 'failing');
  assert.equal(checksState([{ state: 'PENDING' }]), 'pending');
  assert.equal(checksState([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'NEUTRAL' }]), 'passing');
});

test('describeStacks lists the plan in merge order with the retarget each PR needs', () => {
  const text = describeStacks(selectStacks([pr(1, 1), pr(2, 2, { baseRefName: 'agent/issue-101' })]), 'main').join('\n');
  assert.match(text, /docs\/p\.md/);
  assert.match(text, /#1 .*Task 1.*base main/);
  assert.match(text, /#2 .*Task 2.*retarget agent\/issue-101 → main/);
  assert.ok(text.indexOf('#1') < text.indexOf('#2'));
});

// A scripted fake of the few gh calls merge-stack makes.
function fakeGh(prs, script = {}) {
  const calls = [];
  const state = new Map(prs.map((p) => [p.number, { ...p, merged: false }]));
  const views = new Map();
  const run = async (args) => {
    calls.push(args.join(' '));
    const [a, b] = args;
    if (a === 'pr' && b === 'list') return JSON.stringify(prs);
    if (a === 'pr' && b === 'edit') {
      state.get(Number(args[2])).baseRefName = args[args.indexOf('--base') + 1];
      return '';
    }
    if (a === 'pr' && b === 'view') {
      const n = Number(args[2]);
      const seq = script[n] ?? [{ mergeable: 'MERGEABLE', statusCheckRollup: [] }];
      const i = views.get(n) ?? 0;
      views.set(n, i + 1);
      return JSON.stringify({ state: 'OPEN', isDraft: state.get(n).isDraft, ...seq[Math.min(i, seq.length - 1)] });
    }
    if (a === 'pr' && b === 'merge') {
      state.get(Number(args[2])).merged = true;
      return '';
    }
    if (a === 'api') return '';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { run, calls, state };
}
const opts = (run, extra = {}) => ({ repo: 'o/r', defaultBranch: 'main', run, sleep: async () => {}, log: () => {}, pollAttempts: 3, ...extra });

test('without --yes it only lists and changes nothing', async () => {
  const gh = fakeGh([pr(1, 1), pr(2, 2, { baseRefName: 'agent/issue-101' })]);
  const out = [];
  const r = await mergeStacks(opts(gh.run, { yes: false, log: (l) => out.push(l) }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, []);
  assert.deepEqual(gh.calls.filter((c) => /^pr (edit|merge)|^api/.test(c)), []);
  assert.match(out.join('\n'), /Dry run/);
});

test('merges bottom-up, retargets each PR first, and deletes branches only after the last merge', async () => {
  const gh = fakeGh([pr(2, 2, { baseRefName: 'agent/issue-101' }), pr(1, 1), pr(3, 3, { baseRefName: 'agent/issue-102' })]);
  const r = await mergeStacks(opts(gh.run, { yes: true }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, [1, 2, 3]);
  const acts = gh.calls.filter((c) => /^pr (edit|merge)|^api/.test(c));
  assert.deepEqual(acts, [
    'pr merge 1 --repo o/r --merge',
    'pr edit 2 --repo o/r --base main',
    'pr merge 2 --repo o/r --merge',
    'pr edit 3 --repo o/r --base main',
    'pr merge 3 --repo o/r --merge',
    'api -X DELETE repos/o/r/git/refs/heads/agent/issue-101',
    'api -X DELETE repos/o/r/git/refs/heads/agent/issue-102',
    'api -X DELETE repos/o/r/git/refs/heads/agent/issue-103',
  ]);
});

test('waits while GitHub computes mergeability, then proceeds', async () => {
  const gh = fakeGh([pr(1, 1)], { 1: [{ mergeable: 'UNKNOWN' }, { mergeable: 'UNKNOWN' }, { mergeable: 'MERGEABLE', statusCheckRollup: [] }] });
  const r = await mergeStacks(opts(gh.run, { yes: true }));
  assert.deepEqual(r.merged, [1]);
});

test('stops at a conflict: earlier PRs stay merged, nothing is deleted', async () => {
  const gh = fakeGh([pr(1, 1), pr(2, 2, { baseRefName: 'agent/issue-101' }), pr(3, 3)], { 2: [{ mergeable: 'CONFLICTING', statusCheckRollup: [] }] });
  const r = await mergeStacks(opts(gh.run, { yes: true }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.merged, [1]);
  assert.equal(r.stoppedAt, 2);
  assert.match(r.reason, /conflict/i);
  assert.equal(gh.calls.filter((c) => c.startsWith('api')).length, 0);
  assert.ok(!gh.calls.includes('pr merge 3 --repo o/r --merge'));
});

test('stops on failing checks, and treats a draft as not ready', async () => {
  const failing = fakeGh([pr(1, 1)], { 1: [{ mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }] });
  const r1 = await mergeStacks(opts(failing.run, { yes: true }));
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /check/i);
  assert.deepEqual(r1.merged, []);

  const draft = fakeGh([pr(1, 1, { isDraft: true })]);
  const r2 = await mergeStacks(opts(draft.run, { yes: true }));
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /draft/i);
});

test('gives up with a clear reason when mergeability or checks never settle', async () => {
  const stuck = fakeGh([pr(1, 1)], { 1: [{ mergeable: 'UNKNOWN' }] });
  const r1 = await mergeStacks(opts(stuck.run, { yes: true }));
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /mergeab/i);

  const pending = fakeGh([pr(1, 1)], { 1: [{ mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }] });
  const r2 = await mergeStacks(opts(pending.run, { yes: true }));
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /pending|running/i);
});

test('reports cleanly when there are no agent PRs', async () => {
  const gh = fakeGh([{ number: 9, title: 'x', headRefName: 'feat/x', baseRefName: 'main', body: '' }]);
  const out = [];
  const r = await mergeStacks(opts(gh.run, { yes: true, log: (l) => out.push(l) }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, []);
  assert.match(out.join('\n'), /no open agent PRs/i);
});
