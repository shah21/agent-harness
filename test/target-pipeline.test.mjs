import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runTarget } from './helpers/target-fixture.mjs';

const head = (dir) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

test('target branches are created in every repository and the prompt names the target', async () => {
  const { verdict, projectDir, outDir } = await runTarget({ agent: 'target-honest.sh' });
  assert.notEqual(verdict.kind, 'harness', JSON.stringify(verdict.reasons));
  assert.equal(head(projectDir), 'agent/issue-7');
  assert.equal(head(join(projectDir, 'target')), 'fix/add-greeting');
  assert.equal(head(join(projectDir, 'target', 'packages', 'core')), 'fix/add-greeting');
  const prompt = readFileSync(join(outDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /## Target repository/);
  assert.match(prompt, /`target`, a clone of `o\/super`/);
});

test('target clone survives the verification clean', async () => {
  const { projectDir } = await runTarget({ agent: 'target-honest.sh' });
  assert.ok(existsSync(join(projectDir, 'target', 'app.txt')));
  assert.equal(readFileSync(join(projectDir, 'target', 'packages', 'core', 'lib.txt'), 'utf8'), 'b\n');
});

test('a target path that is not git-ignored blocks before the agent runs', async () => {
  const { verdict } = await runTarget({ agent: 'target-honest.sh', gitignore: false });
  assert.equal(verdict.outcome, 'BLOCKED');
  assert.equal(verdict.kind, 'harness');
  assert.deepEqual(verdict.reasons, ['target path "target" is not git-ignored']);
});

test('a checkout failure recorded by the workflow blocks', async () => {
  const { verdict } = await runTarget({
    agent: 'target-honest.sh',
    beforeRun: ({ outDir }) => writeFileSync(join(outDir, 'target-checkout.txt'), 'target checkout failed\n'),
  });
  assert.deepEqual(verdict.reasons, ['target checkout failed']);
  assert.equal(verdict.kind, 'harness');
});

test('a missing PR body template blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-honest.sh', targetConfig: { pr: { body: '.github/agent-pr-body.md' } } });
  assert.deepEqual(verdict.reasons, ['PR body template not found: .github/agent-pr-body.md']);
});

test('target tokens never reach the agent', async () => {
  const { outDir } = await runTarget({ agent: 'env-dump.sh', env: { TARGET_READ_TOKEN: 'secret-read', TARGET_PUSH_TOKEN: 'secret-push' } });
  const env = readFileSync(join(outDir, 'agent-env.txt'), 'utf8');
  assert.doesNotMatch(env, /secret-read|secret-push|TARGET_/);
});

test('the commit author comes from target.author', async () => {
  const { projectDir } = await runTarget({ agent: 'target-honest.sh', targetConfig: { author: { name: 'Jane Doe', email: 'jane@example.com' } } });
  const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: join(projectDir, 'target'), encoding: 'utf8' }).trim();
  assert.equal(author, 'Jane Doe <jane@example.com>');
});

test('READY with target commits: combined counts, thin bundles and PR text in the verdict', async () => {
  const { verdict, outDir, remotes } = await runTarget({ agent: 'target-honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.consumerCommits, 0);
  assert.equal(verdict.commits, 2);
  assert.deepEqual(verdict.targets.map(({ repo, path, role, branch, base, commits, bundle }) => ({ repo, path, role, branch, base, commits, bundle })), [
    { repo: 'o/sub', path: 'target/packages/core', role: 'sub', branch: 'fix/add-greeting', base: null, commits: 1, bundle: 'bundles/o__sub.bundle' },
    { repo: 'o/super', path: 'target', role: 'super', branch: 'fix/add-greeting', base: null, commits: 1, bundle: 'bundles/o__super.bundle' },
  ]);
  assert.ok(verdict.diff.some((d) => d.path === 'target/packages/core/lib.txt'));
  const sup = verdict.targets[1];
  assert.equal(sup.prTitle, 'Task 1: Add greeting');
  assert.match(sup.prBody, /## Summary\nDid the task\./);
  // Thin bundle: it needs the base commit, which the remote has.
  execFileSync('git', ['clone', '-q', '--bare', remotes.super, join(outDir, 'verify.git')]);
  execFileSync('git', ['bundle', 'verify', join(outDir, sup.bundle)], { cwd: join(outDir, 'verify.git'), stdio: 'ignore' });
});

test('a submodule change the superproject does not point at blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-no-pointer.sh' });
  assert.equal(verdict.kind, 'gate');
  assert.deepEqual(verdict.reasons, ['submodule target/packages/core changed but the superproject does not point at it']);
});

test('editing CI inside the target blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-edit-ci.sh' });
  assert.equal(verdict.kind, 'gate');
  assert.match(verdict.reasons[0], /protected paths: target\/\.github\/workflows\/x\.yml/);
});

test('switching branch inside the target blocks', async () => {
  const { verdict } = await runTarget({ agent: 'target-switch-branch.sh' });
  assert.deepEqual(verdict.reasons, ['agent switched target to branch "elsewhere"; work must stay on fix/add-greeting']);
});

test('consumer-only commits leave targets with zero commits and no PR text', async () => {
  const { verdict } = await runTarget({ agent: 'honest.sh' });
  assert.equal(verdict.outcome, 'READY_FOR_QA', JSON.stringify(verdict.reasons));
  assert.equal(verdict.consumerCommits, 1);
  assert.ok(verdict.targets.every((t) => t.commits === 0 && t.bundle === null && t.prBody === null));
});

test('a parent base from the selection is recorded per repository', async () => {
  const { verdict } = await runTarget({ agent: 'target-honest.sh', selection: { targets: { superBranch: 'main', bases: { 'o/super': 'fix/prev' } } } });
  assert.equal(verdict.targets.find((t) => t.role === 'super').base, 'fix/prev');
  assert.equal(verdict.targets.find((t) => t.role === 'sub').base, null);
});
