import { cpSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTask } from '../../harness/run-task.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
export const AGENTS = join(HERE, '..', 'fake-agents');
export const ISSUE = { number: 7, title: 'Task 1', body: 'plan: docs/plan.md\ntask: 1\n', labels: ['agent'] };

const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A bare superproject whose .gitmodules names https://github.com/o/sub.git, plus the
// environment that makes git resolve that URL to a local bare repository.
function makeRemotes(root) {
  const sub = join(root, 'sub.git');
  const sup = join(root, 'super.git');
  const subWork = join(root, 'sub-work');
  const supWork = join(root, 'super-work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', sub]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', sup]);
  for (const bare of [sub, sup]) git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  execFileSync('git', ['init', '-q', '-b', 'main', subWork]);
  writeFileSync(join(subWork, 'lib.txt'), 'a\n');
  git(subWork, 'add', '-A');
  git(subWork, 'commit', '-qm', 'sub base');
  git(subWork, 'push', '-q', sub, 'main');
  execFileSync('git', ['init', '-q', '-b', 'main', supWork]);
  writeFileSync(join(supWork, 'app.txt'), 'app\n');
  git(supWork, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'packages/core');
  git(supWork, 'config', '-f', '.gitmodules', 'submodule.packages/core.url', 'https://github.com/o/sub.git');
  git(supWork, 'add', '-A');
  git(supWork, 'commit', '-qm', 'super base');
  git(supWork, 'push', '-q', sup, 'main');
  const gitEnv = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.${sub}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/o/sub.git',
    GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
  };
  return { sub, super: sup, gitEnv };
}

export function makeTargetProject({ mutate, gitignore = true, targetConfig = {}, ref = 'main' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-target-'));
  const remotes = makeRemotes(root);
  const projectDir = join(root, 'project');
  cpSync(join(HERE, '..', 'fixtures', 'project'), projectDir, { recursive: true });
  const configPath = join(projectDir, 'agent.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.target = { repo: 'o/super', path: 'target', branch: '{type}/{slug}', ...targetConfig };
  config.testGlobs = ['tests/**', 'target/**/tests/**'];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (gitignore) writeFileSync(join(projectDir, '.gitignore'), 'build/\ntarget/\n');
  execFileSync('git', ['init', '-q', '-b', 'main', projectDir]);
  if (mutate) mutate(projectDir);
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-qm', 'fixture');
  // What the workflow's checkout step does: clone with submodules into the target path.
  execFileSync('git', ['clone', '-q', '--recurse-submodules', '-b', ref, remotes.super, join(projectDir, 'target')], {
    env: { ...process.env, ...remotes.gitEnv }, stdio: 'ignore',
  });
  return { projectDir, remotes };
}

export async function runTarget({ agent, cmd, mutate, gitignore, targetConfig, selection = null, env = {}, beforeRun } = {}) {
  const { projectDir, remotes } = makeTargetProject({ mutate, gitignore, targetConfig });
  const outDir = mkdtempSync(join(tmpdir(), 'harness-target-out-'));
  if (beforeRun) beforeRun({ projectDir, outDir });
  const AGENT_CMD = cmd ?? `sh "${join(AGENTS, agent)}"`;
  const verdict = await runTask({
    projectDir, issue: ISSUE, outDir, baseBranch: 'main', selection,
    env: { ...process.env, ...env, AGENT_CMD },
  });
  return { verdict, projectDir, outDir, remotes };
}
