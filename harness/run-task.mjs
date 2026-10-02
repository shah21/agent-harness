#!/usr/bin/env node
// Runs one task locally and writes verdict.json. Network-free: GitHub
// interaction (select, claim, publish) happens in the workflow around it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './lib/config.mjs';
import { parseTaskRef, findTaskHeading } from './lib/issue.mjs';
import { decide } from './lib/gate.mjs';
import { runWithTimeout } from './lib/run-cmd.mjs';
import { agentCommand, agentEnv, renderPrompt } from './lib/agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const blocked = (kind, reason) => ({ outcome: 'BLOCKED', kind, reasons: [reason], warnings: [] });

export function parseDiff(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split('\t');
      const s = status[0];
      return s === 'R' || s === 'C' ? { status: s, oldPath: a, path: b } : { status: s, path: a };
    });
}

async function runChecks(config, projectDir, logsDir, phase, env) {
  const results = {};
  for (const [name, cmd] of Object.entries(config.checks)) {
    const r = await runWithTimeout(cmd, {
      cwd: projectDir,
      timeoutSec: config.timeouts.check,
      logFile: join(logsDir, `${phase}-${name}.log`),
      env,
    });
    results[name] = { ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut, durationSec: r.durationSec };
  }
  return results;
}

export async function runTask({ projectDir, issue, outDir, baseBranch, env = process.env }) {
  projectDir = resolve(projectDir);
  outDir = resolve(outDir);
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const reportPath = join(outDir, 'report.md');
  const verdictPath = join(outDir, 'verdict.json');
  // A verdict from an earlier run (or one the agent plants) must never be published.
  rmSync(reportPath, { force: true });
  rmSync(verdictPath, { force: true });

  const meta = {
    issue: issue.number, issueTitle: issue.title, baseBranch, branch: `agent/issue-${issue.number}`,
    plan: null, task: null, taskTitle: null, model: null, commits: 0, checks: {}, report: null, reportText: null,
  };
  const finish = (result) => {
    const verdict = { ...meta, ...result };
    writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));
    return verdict;
  };
  const state = { agentRan: false, baseSha: null };

  try {
    return await execute({ projectDir, issue, outDir, logsDir, reportPath, env, meta, finish, state });
  } catch (e) {
    // The agent can leave the repository in any state; a crash here must still
    // produce a BLOCKED verdict rather than no verdict at all.
    let commits = 0;
    try {
      if (state.baseSha) commits = Number(git(projectDir, 'rev-list', '--count', `${state.baseSha}..${meta.branch}`));
    } catch {
      // repository unreadable
    }
    const where = state.agentRan ? 'harness failed after the agent ran' : 'harness error';
    return finish({ ...blocked('harness', `${where}: ${String(e.message).split('\n')[0]}`), commits });
  }
}

async function execute({ projectDir, issue, outDir, logsDir, reportPath, env, meta, finish, state }) {
  // Install and checks run project code: give them no tokens at all.
  const quietEnv = agentEnv(env, {});
  delete quietEnv.CLAUDE_CODE_OAUTH_TOKEN;

  const configPath = join(projectDir, 'agent.config.json');
  if (!existsSync(configPath)) return finish(blocked('harness', 'agent.config.json not found in project root'));
  let config;
  try {
    config = loadConfig(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return finish(blocked('harness', `invalid agent.config.json: ${e.message}`));
  }

  const ref = parseTaskRef(issue.body);
  if (ref.error) return finish(blocked('gate', `bad task reference: ${ref.error}`));
  meta.plan = ref.plan;
  meta.task = ref.task;
  const planPath = join(projectDir, ref.plan);
  if (!existsSync(planPath)) return finish(blocked('gate', `bad task reference: plan file not found: ${ref.plan}`));
  meta.taskTitle = findTaskHeading(readFileSync(planPath, 'utf8'), ref.task);
  if (!meta.taskTitle) return finish(blocked('gate', `bad task reference: no "Task ${ref.task}:" heading in ${ref.plan}`));
  meta.model = issue.labels.includes('agent:opus') ? 'opus' : config.model;

  git(projectDir, 'checkout', '-q', '-B', meta.branch);
  git(projectDir, 'config', 'user.name', 'agent-harness');
  git(projectDir, 'config', 'user.email', 'agent-harness@users.noreply.github.com');

  const install = (logName) =>
    runWithTimeout(config.install, {
      cwd: projectDir, timeoutSec: config.timeouts.install, logFile: join(logsDir, logName), env: quietEnv,
    });
  const installFailed = (r) => r.timedOut || r.exitCode !== 0;

  const firstInstall = await install('install.log');
  if (installFailed(firstInstall)) {
    return finish(blocked('harness', firstInstall.timedOut ? 'install timed out' : `install failed (exit ${firstInstall.exitCode})`));
  }

  const baseline = await runChecks(config, projectDir, logsDir, 'baseline', quietEnv);
  const red = Object.entries(baseline).filter(([, c]) => !c.ok).map(([name]) => name);
  if (red.length) {
    return finish({ ...blocked('gate', `base is red: ${red.join(', ')} failed before the agent started`), checks: baseline });
  }

  const baseSha = git(projectDir, 'rev-parse', 'HEAD');
  state.baseSha = baseSha;
  const dirtyBefore = git(projectDir, 'status', '--porcelain');
  const promptText = renderPrompt(readFileSync(join(HERE, 'prompt.md'), 'utf8'), {
    ISSUE: issue.number,
    PLAN: ref.plan,
    TASK: ref.task,
    TASK_TITLE: meta.taskTitle,
    REPORT_PATH: reportPath,
    BRANCH: meta.branch,
    CHECKS: Object.entries(config.checks).map(([name, cmd]) => `   - ${name}: \`${cmd}\``).join('\n'),
    PROTECTED: config.protectedPaths.map((p) => `\`${p}\``).join(', '),
  });
  const promptFile = join(outDir, 'prompt.md');
  writeFileSync(promptFile, promptText);

  state.agentRan = true;
  const agent = await runWithTimeout(
    agentCommand({ model: meta.model, maxTurns: config.maxTurns, promptText, addDir: outDir, override: env.AGENT_CMD }),
    {
      cwd: projectDir,
      timeoutSec: config.timeouts.claude,
      logFile: join(logsDir, 'agent.log'),
      env: agentEnv(env, { REPORT_PATH: reportPath, PROMPT_FILE: promptFile }),
    },
  );

  const head = git(projectDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (head !== meta.branch) return finish(blocked('gate', `agent switched to branch "${head}"; work must stay on ${meta.branch}`));

  const warnings = [];
  const dirtyAfter = git(projectDir, 'status', '--porcelain');
  if (dirtyAfter) {
    if (dirtyAfter !== dirtyBefore) warnings.push('agent left uncommitted changes; they were stashed and are not part of this result');
    git(projectDir, 'stash', 'push', '--include-untracked', '-q', '-m', 'agent-harness: uncommitted changes');
  }

  const commits = Number(git(projectDir, 'rev-list', '--count', `${baseSha}..HEAD`));
  const diff = parseDiff(git(projectDir, 'diff', '--name-status', '-M', baseSha, 'HEAD'));
  const agentFailed = agent.timedOut || agent.exitCode !== 0;
  let checks = {};
  if (!agentFailed) {
    // Verify what a clean checkout of the commits would see: drop ignored
    // files the agent may have left (build output, installed packages) and
    // install again from the committed manifests.
    git(projectDir, 'clean', '-fdXq');
    const reinstall = await install('install-verify.log');
    if (installFailed(reinstall)) {
      return finish({ ...blocked('harness', `install before verification failed (exit ${reinstall.exitCode})`), commits, diff, baseSha });
    }
    checks = await runChecks(config, projectDir, logsDir, 'verify', quietEnv);
  }
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;

  const decision = decide({ agent, reportText, commits, diff, checks, config });
  return finish({
    ...decision,
    warnings: [...warnings, ...decision.warnings],
    report: decision.report ?? null,
    reportText,
    commits,
    diff,
    checks,
    baseSha,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { project: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' }, 'base-branch': { type: 'string' } },
  });
  for (const key of ['project', 'issue', 'out', 'base-branch']) {
    if (!values[key]) {
      console.error(`missing --${key}`);
      process.exit(2);
    }
  }
  const verdict = await runTask({
    projectDir: values.project,
    issue: JSON.parse(readFileSync(values.issue, 'utf8')),
    outDir: values.out,
    baseBranch: values['base-branch'],
  });
  console.log(`${verdict.outcome}${verdict.kind ? ` (${verdict.kind})` : ''}: ${verdict.reasons.join('; ') || 'all checks passed'}`);
}
