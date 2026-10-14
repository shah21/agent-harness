// Review → fix → verify rounds after a READY task. The outcome stays READY_FOR_QA whatever
// happens here; every repository always ends on the last state whose checks passed.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runWithTimeout } from './run-cmd.mjs';
import { agentCommand, agentEnv, detectUsageLimit } from './agent.mjs';
import { snapshot, enforceReadOnly } from './debug-guard.mjs';
import {
  parseReviewOutput, parseFixReplies, withoutCommit, nextStep, actionable, openFindings, fitsBudget, parseVerifyReplies, applyVerification,
} from './review.mjs';
import {
  readRules, nearestContext, changedPaths, changedHunks, diffText, planTaskSection, planGoal, historyText, copySkill,
  renderReviewPrompt, renderFixPrompt, renderVerifyPrompt,
} from './review-inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Reviewer and verifier may run commands to probe the change; read-only is enforced by snapshot and revert.
const REVIEW_TOOLS = 'Read,Glob,Grep,Write,Bash';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const key = (r) => r.prefix || '.';
const heads = (repos) => Object.fromEntries(repos.map((r) => [key(r), git(r.dir, 'rev-parse', 'HEAD')]));
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

function resetTo(repos, shas) {
  for (const r of repos) {
    git(r.dir, 'checkout', '-q', '-f', r.branch);
    git(r.dir, 'reset', '-q', '--hard', shas[key(r)]);
    git(r.dir, 'clean', '-fdq');
  }
}

export async function runReviewLoop({
  config, repos, planText, task, implementerModel, accounts, env, projectDir, outDir, logsDir, verify, gateReasons, targetSection = '',
}) {
  const rc = config.review;
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  const rounds = [];
  const warnings = [];
  let green = heads(repos);
  let finalChecks = null;
  let longest = 0;
  let exit = null;
  let error = null;

  const reviewTemplate = readFileSync(join(HERE, '..', 'review-prompt.md'), 'utf8');
  const fixTemplate = readFileSync(join(HERE, '..', 'fix-prompt.md'), 'utf8');
  const verifyTemplate = readFileSync(join(HERE, '..', 'verify-prompt.md'), 'utf8');
  const goal = planGoal(planText);
  const skillDir = join(outDir, 'review-skill');
  const planTask = planTaskSection(planText, task);

  // One agent session, tried on each account in turn while the account is out of usage.
  const session = async ({ name, round, model, tools, promptText, outputPath, override, onLimit }) => {
    writeFileSync(join(outDir, `${name}.prompt.md`), promptText);
    for (const [i, attempt] of accounts.entries()) {
      rmSync(outputPath, { force: true });
      const logFile = join(logsDir, i === 0 ? `${name}.log` : `${name}-${i + 1}.log`);
      const extra = { ...config.env, AGENT_OUTPUT_PATH: outputPath, AGENT_REVIEW_ROUND: String(round) };
      if (attempt.token) extra.CLAUDE_CODE_OAUTH_TOKEN = attempt.token;
      const r = await runWithTimeout(
        agentCommand({ model, maxTurns: rc.maxTurns, promptText, addDir: outDir, override, tools }),
        { cwd: projectDir, timeoutSec: Math.max(1, Math.floor(rc.timeout - elapsed())), logFile, env: agentEnv(env, extra) },
      );
      if (r.exitCode === 0 || !detectUsageLimit(readFileSync(logFile, 'utf8'))) {
        return { timedOut: r.timedOut, text: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null };
      }
      onLimit?.();
    }
    return { limited: true };
  };

  try {
    const rules = readRules(repos, rc.rules);
    const skill = copySkill(repos, rc.skill, skillDir);
    if (skill.error) {
      exit = 'reviewer-error';
      error = skill.error;
    }
    for (let n = 1; !exit; n++) {
      if (n > 1 && !fitsBudget({ elapsedSec: elapsed(), budgetSec: rc.timeout, longestStepSec: longest })) { exit = 'budget'; break; }
      const reviewStart = Date.now();
      const paths = changedPaths(repos);
      const reviewPath = join(outDir, `review-${n}.md`);
      const snaps = snapshot(repos.map((r) => r.dir));
      const review = await session({
        name: `review-${n}`, round: n, model: rc.model, tools: REVIEW_TOOLS, outputPath: reviewPath, override: env.AGENT_REVIEW_CMD,
        promptText: renderReviewPrompt(reviewTemplate, {
          round: n, goal, skillDir, planTask, diff: diffText(repos), rules, contexts: nearestContext(repos, paths), history: historyText(rounds), outputPath: reviewPath,
        }),
      });
      if (enforceReadOnly(snaps).length) warnings.push(`review round ${n}: the reviewer changed the checkout; changes were discarded`);
      if (review.limited) { exit = 'usage-limit'; break; }
      if (review.timedOut) { exit = 'budget'; break; }
      const parsed = parseReviewOutput(review.text, paths, changedHunks(repos));
      if (!parsed.ok) { exit = 'reviewer-error'; error = parsed.error; break; }

      // A fresh session tries to refute each high and medium finding before anything is fixed.
      let findings = parsed.findings;
      const toCheck = findings.filter((f) => f.severity !== 'low');
      if (toCheck.length) {
        const verifyPath = join(outDir, `verify-${n}.md`);
        const verifySnaps = snapshot(repos.map((r) => r.dir));
        const check = await session({
          name: `verify-${n}`, round: n, model: rc.model, tools: REVIEW_TOOLS, outputPath: verifyPath, override: env.AGENT_VERIFY_CMD,
          promptText: renderVerifyPrompt(verifyTemplate, { round: n, skillDir, planTask, diff: diffText(repos), findings: toCheck, outputPath: verifyPath }),
        });
        if (enforceReadOnly(verifySnaps).length) warnings.push(`review round ${n}: the verifier changed the checkout; changes were discarded`);
        const failed = check.limited || check.timedOut || check.text === null;
        if (failed) warnings.push(`review round ${n}: verification failed; all findings kept`);
        findings = applyVerification(findings, parseVerifyReplies(failed ? null : check.text, toCheck.map((f) => f.id)));
      }

      const round = { n, findings };
      rounds.push(round);
      longest = Math.max(longest, (Date.now() - reviewStart) / 1000);
      const step = nextStep({ round: n, maxRounds: rc.maxRounds, findings, previous: rounds.at(-2)?.findings ?? null });
      if (step !== 'fix') { exit = step; round.durationSec = Math.round((Date.now() - reviewStart) / 1000); break; }
      if (!fitsBudget({ elapsedSec: elapsed(), budgetSec: rc.timeout, longestStepSec: longest })) { exit = 'budget'; break; }

      const fixStart = Date.now();
      const toFix = actionable(findings);
      const ids = toFix.map((f) => f.id);
      const fixPath = join(outDir, `fix-${n}.md`);
      const fix = await session({
        name: `fix-${n}`, round: n, model: implementerModel, outputPath: fixPath, override: env.AGENT_FIX_CMD,
        onLimit: () => resetTo(repos, green),
        promptText: renderFixPrompt(fixTemplate, {
          round: n, branch: repos[0].branch, planTask, diff: diffText(repos), findings: toFix, outputPath: fixPath,
          checks: config.checks, protectedPaths: config.protectedPaths, hasSetup: Boolean(config.setup),
        }) + targetSection,
      });
      if (fix.limited) { resetTo(repos, green); exit = 'usage-limit'; break; }
      round.fixes = parseFixReplies(fix.text, ids);
      if (fix.timedOut) { resetTo(repos, green); round.reverted = true; exit = 'budget'; break; }

      const off = repos.find((r) => git(r.dir, 'rev-parse', '--abbrev-ref', 'HEAD') !== r.branch);
      if (off) {
        resetTo(repos, green);
        round.reverted = true;
        exit = 'gate';
        error = `fixer switched ${off.prefix ? off.prefix.slice(0, -1) : 'the repository'} off ${off.branch}`;
        break;
      }
      for (const r of repos) {
        if (git(r.dir, 'status', '--porcelain', '--ignore-submodules=all')) {
          git(r.dir, 'stash', 'push', '--include-untracked', '-q', '-m', 'agent-harness: uncommitted review fix changes');
          warnings.push(`review round ${n}: the fixer left uncommitted changes; they were stashed`);
        }
      }

      const after = heads(repos);
      round.reverted = false;
      if (same(after, green)) {
        round.fixes = withoutCommit(round.fixes);
        round.commit = null;
        round.durationSec = Math.round((Date.now() - reviewStart) / 1000);
        longest = Math.max(longest, (Date.now() - fixStart) / 1000);
        continue;
      }
      round.commit = after['.'] !== green['.'] ? after['.'] : null;
      const moved = repos.filter((r) => r.prefix && after[key(r)] !== green[key(r)]);
      if (moved.length) round.targets = Object.fromEntries(moved.map((r) => [r.prefix.slice(0, -1), after[key(r)]]));

      const violations = gateReasons();
      if (violations.length) { resetTo(repos, green); round.reverted = true; exit = 'gate'; error = violations.join('; '); break; }
      const verified = await verify(`review-${n}`);
      round.checks = verified.checks ?? {};
      if (verified.error || !Object.values(verified.checks).every((c) => c.ok)) {
        resetTo(repos, green);
        round.reverted = true;
        exit = 'fix-broke-checks';
        error = verified.error ?? null;
        break;
      }
      green = after;
      finalChecks = verified.checks;
      round.durationSec = Math.round((Date.now() - reviewStart) / 1000);
      longest = Math.max(longest, (Date.now() - fixStart) / 1000);
    }
  } catch (e) {
    try {
      resetTo(repos, green);
    } catch {
      // repository unreadable; the run's own crash handling takes over
    }
    exit = 'reviewer-error';
    error = String(e.message).split('\n')[0];
  }
  return {
    review: { model: rc.model, exit, rounds, open: openFindings(rounds), ...(error ? { error } : {}) },
    finalChecks,
    warnings,
  };
}
