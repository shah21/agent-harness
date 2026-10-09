#!/usr/bin/env node
// Runs one read-only debug investigation locally and writes verdict.json.
// Network-free: GitHub interaction (select, claim, publish) happens in the workflow around it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './lib/config.mjs';
import { runWithTimeout } from './lib/run-cmd.mjs';
import {
  agentCommand, agentEnv, renderPrompt, claudeTokens, detectUsageLimit, detectAuthFailure, servicesRule,
} from './lib/agent.mjs';
import { probeAccounts } from './lib/probe.mjs';
import { prepareTarget } from './lib/target-run.mjs';
import { parseDebugIssue, parseDebugReport } from './lib/debug.mjs';
import { snapshot, enforceReadOnly } from './lib/debug-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEBUG_TOOLS = 'Read,Write,Glob,Grep,Bash';
const MAX_CONTEXT_CHARS = 100000;

const blocked = (kind, reason, extra = {}) => ({ outcome: 'BLOCKED', kind, reasons: [reason], ...extra });

export async function runDebug({ projectDir, issue, outDir, configPath, env = process.env }) {
  projectDir = resolve(projectDir);
  outDir = resolve(outDir);
  const logsDir = join(outDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const reportPath = join(outDir, 'report.md');
  const verdictPath = join(outDir, 'verdict.json');
  rmSync(reportPath, { force: true });
  rmSync(verdictPath, { force: true });

  const meta = {
    mode: 'debug', issue: issue.number, issueTitle: issue.title, ref: null, model: null, account: null,
    investigated: [], report: null, reportText: null,
  };
  const finish = (result) => {
    const verdict = { kind: null, reasons: [], warnings: [], ...meta, ...result };
    writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));
    return verdict;
  };
  const state = { snaps: null };

  try {
    return await execute({ projectDir, issue, outDir, logsDir, reportPath, configPath, env, meta, finish, state });
  } catch (e) {
    // Whatever the agent left behind, a crash must still produce a verdict and an untouched checkout.
    try {
      if (state.snaps) enforceReadOnly(state.snaps);
    } catch {
      // repository unreadable
    }
    return finish(blocked('harness', `harness error: ${String(e.message).split('\n')[0]}`));
  }
}

async function execute({ projectDir, issue, outDir, logsDir, reportPath, configPath: configOverride, env, meta, finish, state }) {
  const configPath = configOverride ?? join(projectDir, 'agent.config.json');
  if (!existsSync(configPath)) return finish(blocked('harness', 'agent.config.json not found in project root'));
  let config;
  try {
    config = loadConfig(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return finish(blocked('harness', `invalid agent.config.json: ${e.message}`));
  }
  const quietEnv = { ...agentEnv(env, {}), ...config.env };
  delete quietEnv.CLAUDE_CODE_OAUTH_TOKEN;

  const parsed = parseDebugIssue(issue.body);
  if (parsed.error) return finish(blocked('gate', `bad issue: ${parsed.error}`));
  meta.ref = parsed.ref;
  meta.model = issue.labels.includes('agent:opus') ? 'opus' : config.model;

  let contextText = '(none)';
  let contextName = '';
  if (parsed.context) {
    const file = join(projectDir, parsed.context);
    if (!existsSync(file)) return finish(blocked('gate', `context file not found: ${parsed.context}`));
    const real = realpathSync(file);
    if (!real.startsWith(realpathSync(projectDir) + sep)) {
      return finish(blocked('gate', `context path escapes the repository: ${parsed.context}`));
    }
    contextText = readFileSync(real, 'utf8').slice(0, MAX_CONTEXT_CHARS);
    contextName = ` (${parsed.context})`;
  }

  let target = null;
  if (config.target) {
    target = prepareTarget({
      projectDir, outDir, target: config.target, issue, task: 0, taskTitle: 'debug', parentBases: null,
    });
    if (target.error) return finish(blocked('harness', target.error));
  }

  const tokens = claudeTokens(env);
  let accounts = tokens.map((token, i) => ({ token, account: i + 1 }));
  if (tokens.length && !(env.AGENT_CMD && !env.AGENT_PROBE_CMD)) {
    const { usable, limited } = await probeAccounts({ tokens, model: meta.model, env, projectDir, logsDir });
    if (usable.length === 0) {
      if (limited > 0) {
        return finish({ outcome: 'WAITING', kind: 'usage-limit', reasons: [`usage limit reached on all ${tokens.length} Claude accounts`] });
      }
      return finish(blocked('agent', 'Claude did not respond on any account; see logs/probe-*.log'));
    }
    accounts = usable;
  }
  if (accounts.length === 0) accounts = [{ token: undefined, account: null }];

  const runStep = async (command, logName, timeoutSec, extra = {}) =>
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

  const dirs = [projectDir, ...(target ? target.repos.map((r) => r.dir) : [])];
  state.snaps = snapshot(dirs);
  meta.investigated = state.snaps.map((s) => ({ path: relative(projectDir, s.dir) || '.', sha: s.head }));

  const targetSection = target
    ? `- The code under investigation is in \`${config.target.path}\`, a clone of \`${config.target.repo}\`${parsed.ref ? ` checked out at \`${parsed.ref}\`` : ''} (submodules at their recorded commits). The working directory is the repository that queued this investigation; use it for context only.`
    : '';
  const promptText = renderPrompt(readFileSync(join(HERE, 'debug-prompt.md'), 'utf8'), {
    ISSUE: issue.number,
    ISSUE_TITLE: issue.title,
    TARGET_SECTION: targetSection,
    REPORT_PATH: reportPath,
    SERVICES_RULE: servicesRule(Boolean(config.setup)),
    SKILL: readFileSync(join(HERE, 'debug', 'systematic-debugging', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, ''),
    CONTEXT_PATHS: config.debug.contextPaths.length ? config.debug.contextPaths.map((p) => `\`${p}\``).join(', ') : '(none configured)',
    SYMPTOM: parsed.symptom,
    CONTEXT_NAME: contextName,
    CONTEXT_TEXT: contextText,
  });
  const promptFile = join(outDir, 'prompt.md');
  writeFileSync(promptFile, promptText);

  const warnings = [];
  let agent;
  for (const [i, attempt] of accounts.entries()) {
    rmSync(reportPath, { force: true });
    meta.account = attempt.account;
    const logFile = join(logsDir, i === 0 ? 'agent.log' : `agent-${i + 1}.log`);
    const extra = { ...config.env, REPORT_PATH: reportPath, PROMPT_FILE: promptFile };
    if (attempt.token) extra.CLAUDE_CODE_OAUTH_TOKEN = attempt.token;
    agent = await runWithTimeout(
      agentCommand({ model: meta.model, maxTurns: config.debug.maxTurns, promptText, addDir: outDir, override: env.AGENT_CMD, tools: DEBUG_TOOLS }),
      { cwd: projectDir, timeoutSec: config.debug.timeout, logFile, env: agentEnv(env, extra) },
    );
    const text = readFileSync(logFile, 'utf8');
    if (agent.exitCode === 0 || !detectUsageLimit(text)) break;
    enforceReadOnly(state.snaps);
    if (i === accounts.length - 1) {
      return finish({ outcome: 'WAITING', kind: 'usage-limit', reasons: [`usage limit reached on all ${Math.max(tokens.length, 1)} Claude accounts`] });
    }
    warnings.push(`usage limit hit on Claude account ${attempt.account}; restarted on account ${accounts[i + 1].account}`);
  }

  const changed = enforceReadOnly(state.snaps);
  if (changed.length) {
    warnings.push(`agent modified the checkout; changes were discarded (${changed.map((d) => relative(projectDir, d) || '.').join(', ')})`);
  }

  const failed = agent.timedOut || agent.exitCode !== 0;
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  if (reportText === null) {
    const reason = failed
      ? (agent.timedOut ? 'agent timed out before writing a report' : `agent failed (exit ${agent.exitCode}) before writing a report`)
      : 'agent finished without writing a report';
    return finish(blocked('agent', reason, { warnings }));
  }
  const parsedReport = parseDebugReport(reportText);
  if (!parsedReport.ok) return finish(blocked('agent', `invalid report: ${parsedReport.errors.join('; ')}`, { warnings, reportText }));

  warnings.push(...parsedReport.warnings);
  const report = parsedReport.report;
  if (report.status === 'BLOCKED') {
    return finish({ outcome: 'BLOCKED', kind: 'agent', reasons: ['agent reported BLOCKED'], warnings, report, reportText });
  }
  let outcome = report.status;
  if (failed) {
    outcome = 'INCONCLUSIVE';
    warnings.push(agent.timedOut ? 'agent timed out; the report may be partial' : `agent exited with code ${agent.exitCode}; the report may be partial`);
  }
  return finish({ outcome, warnings, report, reportText });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { project: { type: 'string' }, issue: { type: 'string' }, out: { type: 'string' }, config: { type: 'string' } },
  });
  for (const key of ['project', 'issue', 'out']) {
    if (!values[key]) {
      console.error(`missing --${key}`);
      process.exit(2);
    }
  }
  const verdict = await runDebug({
    projectDir: values.project,
    issue: JSON.parse(readFileSync(values.issue, 'utf8')),
    outDir: values.out,
    configPath: values.config,
  });
  console.log(`${verdict.outcome}${verdict.kind ? ` (${verdict.kind})` : ''}: ${verdict.reasons.join('; ') || 'report written'}`);
}
