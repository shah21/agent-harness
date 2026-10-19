#!/usr/bin/env node
// Reviews existing pull requests read-only and writes verdict.json. Network-free: selection,
// checkouts and publishing happen in the workflow around it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';
import { runWithTimeout } from './lib/run-cmd.mjs';
import { agentEnv, claudeTokens } from './lib/agent.mjs';
import { probeAccounts } from './lib/probe.mjs';
import { snapshot, enforceReadOnly } from './lib/debug-guard.mjs';
import { actionable } from './lib/review.mjs';
import { copySkill, readRules, planGoal, planTaskSection } from './lib/review-inputs.mjs';
import { createSession, reviewStep, reviewTemplates } from './lib/review-loop.mjs';

const MAX_CONTEXT_CHARS = 100000;
const blocked = (kind, reason, extra = {}) => ({ outcome: 'BLOCKED', kind, reasons: [reason], ...extra });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export async function runReview({ projectDir, issue, outDir, configPath, selection, defaultBranch, env = process.env }) {
  projectDir = resolve(projectDir);
  outDir = resolve(outDir);
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const verdictPath = join(outDir, 'verdict.json');
  rmSync(verdictPath, { force: true });

  const meta = { mode: 'review', issue: issue.number, issueTitle: issue.title, model: null, account: null, prs: [], task: selection?.task ?? null, review: null };
  const finish = (result) => {
    const verdict = { kind: null, reasons: [], warnings: [], ...meta, ...result };
    writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));
    return verdict;
  };
  const state = { snaps: null };
  try {
    return await execute({ projectDir, outDir, logsDir, configPath, selection, defaultBranch, env, meta, finish, state });
  } catch (e) {
    try {
      if (state.snaps) enforceReadOnly(state.snaps);
    } catch {
      // repository unreadable
    }
    return finish(blocked('harness', `harness error: ${String(e.message).split('\n')[0]}`));
  }
}

async function execute({ projectDir, outDir, logsDir, configPath: configOverride, selection, defaultBranch, env, meta, finish, state }) {
  const configPath = configOverride ?? join(projectDir, 'agent.config.json');
  if (!existsSync(configPath)) return finish(blocked('harness', 'agent.config.json not found in project root'));
  let config;
  try {
    config = loadConfig(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return finish(blocked('harness', `invalid agent.config.json: ${e.message}`));
  }
  if (!config.review) return finish(blocked('gate', 'review runs need a "review" block with a "skill" in agent.config.json'));
  const rc = config.review;
  meta.model = rc.model;
  const quietEnv = { ...agentEnv(env, {}), ...config.env };
  delete quietEnv.CLAUDE_CODE_OAUTH_TOKEN;

  // Checkouts made by the workflow (checkout-prs.sh): every repository must sit at its pull request head.
  const checkedPath = join(outDir, 'prs-checked.json');
  if (existsSync(join(outDir, 'pr-checkout.txt')) || !existsSync(checkedPath)) return finish(blocked('harness', 'pull request checkout failed'));
  const checked = JSON.parse(readFileSync(checkedPath, 'utf8'));
  if (!checked.length || checked.some((c) => tryGit(join(projectDir, c.dir), 'rev-parse', 'HEAD') !== c.headSha)) {
    return finish(blocked('harness', 'pull request checkout failed'));
  }
  const info = new Map(selection.prs.map((p) => [`${p.repo}#${p.number}`, p]));
  meta.prs = checked.map((c) => ({
    repo: c.repo, number: c.number, url: info.get(`${c.repo}#${c.number}`)?.url ?? null, headSha: c.headSha, baseSha: c.baseSha, prefix: c.prefix,
  }));
  const repos = checked.map((c) => ({ prefix: c.prefix, dir: join(projectDir, c.dir), base: c.baseSha, branch: 'HEAD' }));

  // The skill and rules may live in a repository no pull request touches: read those at their current commit.
  const known = [...repos];
  const addKnown = (prefix, dir) => {
    if (!known.some((r) => r.prefix === prefix) && existsSync(join(dir, '.git'))) known.push({ prefix, dir, base: git(dir, 'rev-parse', 'HEAD'), branch: 'HEAD' });
  };
  addKnown('', projectDir);
  if (config.target) addKnown(`${config.target.path}/`, join(projectDir, config.target.path));

  // Request files come from the default branch, whatever the pull request changed.
  const atDefault = (path) => tryGit(projectDir, 'show', `${defaultBranch}:${path}`) ?? tryGit(projectDir, 'show', `origin/${defaultBranch}:${path}`);
  let contextText = null;
  if (selection.context) {
    contextText = atDefault(selection.context);
    if (contextText === null) return finish(blocked('gate', `context file not found: ${selection.context}`));
    contextText = contextText.slice(0, MAX_CONTEXT_CHARS);
  }
  const warnings = [];
  let planText = null;
  if (meta.task) {
    planText = atDefault(meta.task.plan);
    if (planText === null) warnings.push(`plan file not found: ${meta.task.plan}`);
  }
  const prText = selection.prs.map((p) => `### ${p.repo}#${p.number}: ${p.title}\n\n${p.body || '(no description)'}`).join('\n\n');
  const planTask = [
    planText ? planTaskSection(planText, meta.task.task) : '(no plan task found; judge the change against the pull request descriptions)',
    '## Pull requests',
    prText,
    ...(contextText ? ['## Context', contextText] : []),
  ].join('\n\n');

  const tokens = claudeTokens(env);
  let accounts = tokens.map((token, i) => ({ token, account: i + 1 }));
  if (tokens.length && !(env.AGENT_CMD && !env.AGENT_PROBE_CMD)) {
    const { usable, limited } = await probeAccounts({ tokens, model: meta.model, env, projectDir, logsDir });
    if (usable.length === 0) {
      if (limited > 0) return finish({ outcome: 'WAITING', kind: 'usage-limit', reasons: [`usage limit reached on all ${tokens.length} Claude accounts`] });
      return finish(blocked('agent', 'Claude did not respond on any account; see logs/probe-*.log'));
    }
    accounts = usable;
  }
  if (accounts.length === 0) accounts = [{ token: undefined, account: null }];

  const runStep = (command, logName, timeoutSec, extra = {}) =>
    runWithTimeout(command, { cwd: projectDir, timeoutSec, logFile: join(logsDir, logName), env: quietEnv, ...extra });
  const install = await runStep(config.install, 'install.log', config.timeouts.install);
  if (install.timedOut || install.exitCode !== 0) {
    return finish(blocked('harness', install.timedOut ? 'install timed out' : `install failed (exit ${install.exitCode})`));
  }
  if (config.setup) {
    const setup = await runStep(config.setup, 'setup.log', config.timeouts.setup, { killGroupOnExit: false });
    if (setup.timedOut || setup.exitCode !== 0) {
      return finish(blocked('harness', setup.timedOut ? 'setup timed out' : `setup failed (exit ${setup.exitCode})`));
    }
  }

  state.snaps = snapshot(known.map((r) => r.dir));
  const skillDir = join(outDir, 'review-skill');
  const skill = copySkill(known, rc.skill, skillDir);
  if (skill.error) return finish(blocked('agent', skill.error, { warnings }));

  const started = Date.now();
  const session = createSession({
    envConfig: config.env, accounts, env, projectDir, outDir, logsDir, maxTurns: rc.maxTurns,
    remainingSec: () => rc.timeout - (Date.now() - started) / 1000,
  });
  const step = await reviewStep({
    n: 1, repos, session, model: rc.model, templates: reviewTemplates(),
    input: { goal: planText ? planGoal(planText) : '', skillDir, planTask, rules: readRules(known, rc.rules), history: '(first review)' },
    env, outDir, warnings,
  });
  enforceReadOnly(state.snaps);

  if (step.limited) {
    return finish({ outcome: 'WAITING', kind: 'usage-limit', reasons: [`usage limit reached on all ${Math.max(tokens.length, 1)} Claude accounts`], warnings });
  }
  if (step.timedOut) return finish(blocked('agent', 'review timed out', { warnings }));
  if (step.error) return finish(blocked('agent', `invalid review: ${step.error}`, { warnings }));
  const confirmed = actionable(step.findings);
  const verdict = confirmed.some((f) => f.severity === 'high') ? 'changes' : confirmed.length ? 'comments' : 'clean';
  return finish({ outcome: 'REVIEWED', warnings, review: { verdict, findings: step.findings } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' },
      selection: { type: 'string' }, 'default-branch': { type: 'string' },
    },
  });
  for (const k of ['project', 'issue', 'out', 'selection', 'default-branch']) {
    if (!values[k]) {
      console.error(`missing --${k}`);
      process.exit(2);
    }
  }
  const verdict = await runReview({
    projectDir: values.project,
    issue: JSON.parse(readFileSync(values.issue, 'utf8')),
    outDir: values.out,
    configPath: values.config,
    selection: JSON.parse(readFileSync(values.selection, 'utf8')),
    defaultBranch: values['default-branch'],
  });
  console.log(`${verdict.outcome}${verdict.kind ? ` (${verdict.kind})` : ''}: ${verdict.reasons.join('; ') || verdict.review?.verdict || ''}`);
}
