#!/usr/bin/env node
// Small commands the reusable workflow calls between gh steps.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { selectNext, selectDebug, targetsToCheck } from './lib/queue.mjs';
import { renderPrBody, renderComment, renderReviewRound, renderReviewSummary } from './lib/format.mjs';
import { renderDebugComment } from './lib/debug-comment.mjs';
import { issueToClose } from './lib/merged.mjs';
import { loadConfig } from './lib/config.mjs';
import { selectReview, buildReviewSelection, checkoutPlan } from './lib/pr-review.mjs';
import { parseGitmodules } from './lib/target.mjs';

const USAGE = `usage:
  cli.mjs select --issues <f> --prs <f> --default-branch <b> [--ready <f>]
  cli.mjs skip-verdict --selection <f>
  cli.mjs fallback-verdict --selection <f>
  cli.mjs render-pr --verdict <f>
  cli.mjs target-info --config <f> --selection <f> --out <dir>
  cli.mjs targets-to-check --ready <f>
  cli.mjs render-comment --verdict <f> --run-url <u> [--pr-url <u>] [--target-prs <f>]
  cli.mjs merged-issue --event <f>
  cli.mjs select-debug --issues <f>
  cli.mjs debug-info --config <f> --selection <f> --out <dir>
  cli.mjs debug-skip-verdict --selection <f>
  cli.mjs debug-fallback-verdict --selection <f>
  cli.mjs render-debug-comment --verdict <f> --run-url <u>
  cli.mjs render-review-comments --verdict <f> --out <dir>
  cli.mjs select-review --issues <f>
  cli.mjs review-selection --selection <f> --prs <f> --candidates <f>
  cli.mjs review-checkouts --config <f> --selection <f> --repo <owner/name> --project <dir> --out <dir>
  cli.mjs review-skip-verdict --selection <f>
  cli.mjs review-fallback-verdict --selection <f>`;

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function blockedVerdict(selection, kind, reason) {
  return {
    outcome: 'BLOCKED', kind, reasons: [reason], warnings: [],
    issue: selection.issue.number, issueTitle: selection.issue.title,
    plan: selection.plan, task: selection.task, taskTitle: null,
    baseBranch: selection.base, branch: `agent/issue-${selection.issue.number}`,
    model: null, commits: 0, checks: {}, report: null, reportText: null,
  };
}

function blockedDebugVerdict(selection, kind, reason) {
  return {
    mode: 'debug', outcome: 'BLOCKED', kind, reasons: [reason], warnings: [],
    issue: selection.issue.number, issueTitle: selection.issue.title, ref: selection.ref ?? null,
    model: null, account: null, investigated: [], report: null, reportText: null,
  };
}

function blockedReviewVerdict(selection, kind, reason) {
  return {
    mode: 'review', outcome: 'BLOCKED', kind, reasons: [reason], warnings: [],
    issue: selection.issue.number, issueTitle: selection.issue.title, model: null, prs: [], task: null, review: null,
  };
}

const [command, ...rest] = process.argv.slice(2);
let values;
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      issues: { type: 'string' }, prs: { type: 'string' }, 'default-branch': { type: 'string' },
      selection: { type: 'string' }, verdict: { type: 'string' }, event: { type: 'string' },
      'run-url': { type: 'string' }, 'pr-url': { type: 'string' },
      ready: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, 'target-prs': { type: 'string' },
      candidates: { type: 'string' }, repo: { type: 'string' }, project: { type: 'string' }, body: { type: 'string' },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}

switch (command) {
  case 'select':
    print(selectNext({
      issues: read(values.issues), prs: read(values.prs), defaultBranch: values['default-branch'],
      ready: values.ready ? read(values.ready) : [],
    }));
    break;
  case 'skip-verdict': {
    const selection = read(values.selection);
    print(blockedVerdict(selection, 'gate', selection.skip));
    break;
  }
  case 'fallback-verdict':
    print(blockedVerdict(read(values.selection), 'harness', 'the run ended without a verdict (crash or job timeout); see the run log'));
    break;
  case 'render-pr':
    process.stdout.write(renderPrBody(read(values.verdict)));
    break;
  case 'render-comment':
    process.stdout.write(renderComment(read(values.verdict), {
      runUrl: values['run-url'], prUrl: values['pr-url'],
      targetPrs: values['target-prs'] ? read(values['target-prs']) : undefined,
    }));
    break;
  case 'merged-issue': {
    const issue = issueToClose(read(values.event));
    process.stdout.write(issue === null ? '' : `${issue}\n`);
    break;
  }
  case 'target-info': {
    let target = null;
    try {
      target = loadConfig(readFileSync(values.config, 'utf8')).target;
    } catch {
      // run-task reports an invalid config itself
    }
    if (!target) break;
    if (process.env.HAS_TARGET_READ_TOKEN !== 'true' || process.env.HAS_TARGET_PUSH_TOKEN !== 'true') {
      writeFileSync(join(values.out, 'target-checkout.txt'), 'target configured but TARGET_READ_TOKEN or TARGET_PUSH_TOKEN secret missing\n');
      break;
    }
    const selection = read(values.selection);
    process.stdout.write(`repo=${target.repo}\npath=${target.path}\nref=${selection.targets?.superBranch ?? selection.targetBase ?? ''}\n`);
    break;
  }
  case 'targets-to-check':
    print(targetsToCheck(read(values.ready)));
    break;
  case 'select-debug':
    print(selectDebug({ issues: read(values.issues) }));
    break;
  case 'debug-info': {
    let target = null;
    try {
      target = loadConfig(readFileSync(values.config, 'utf8')).target;
    } catch {
      // debug-run reports an invalid config itself
    }
    if (!target) break;
    if (process.env.HAS_TARGET_READ_TOKEN !== 'true') {
      writeFileSync(join(values.out, 'target-checkout.txt'), 'target configured but TARGET_READ_TOKEN secret missing\n');
      break;
    }
    process.stdout.write(`repo=${target.repo}\npath=${target.path}\nref=${read(values.selection).ref ?? ''}\n`);
    break;
  }
  case 'debug-skip-verdict': {
    const selection = read(values.selection);
    print(blockedDebugVerdict(selection, 'gate', selection.skip));
    break;
  }
  case 'debug-fallback-verdict':
    print(blockedDebugVerdict(read(values.selection), 'harness', 'the run ended without a verdict (crash or job timeout); see the run log'));
    break;
  case 'render-review-comments': {
    const v = read(values.verdict);
    if (!v.review) break;
    mkdirSync(values.out, { recursive: true });
    for (const round of v.review.rounds) {
      writeFileSync(join(values.out, `round-${String(round.n).padStart(2, '0')}.md`), renderReviewRound(round));
    }
    writeFileSync(join(values.out, 'summary.md'), renderReviewSummary(v.review));
    break;
  }
  case 'select-review':
    print(selectReview({ issues: read(values.issues) }));
    break;
  case 'review-selection':
    print(buildReviewSelection({ selection: read(values.selection), prData: read(values.prs), candidates: read(values.candidates) }));
    break;
  case 'review-checkouts': {
    const config = loadConfig(readFileSync(values.config, 'utf8'));
    const modules = config.target ? join(values.project, config.target.path, '.gitmodules') : null;
    const submodules = modules && existsSync(modules) ? parseGitmodules(readFileSync(modules, 'utf8')) : [];
    const result = checkoutPlan({ selection: read(values.selection), consumerRepo: values.repo, target: config.target, submodules });
    if (result.error) writeFileSync(join(values.out, 'pr-checkout.txt'), `${result.error}\n`);
    else writeFileSync(join(values.out, 'checkout-plan.json'), `${JSON.stringify(result.plan, null, 2)}\n`);
    break;
  }
  case 'review-skip-verdict': {
    const selection = read(values.selection);
    print(blockedReviewVerdict(selection, 'gate', selection.skip));
    break;
  }
  case 'review-fallback-verdict':
    print(blockedReviewVerdict(read(values.selection), 'harness', 'the run ended without a verdict (crash or job timeout); see the run log'));
    break;
  case 'render-debug-comment':
    process.stdout.write(renderDebugComment(read(values.verdict), { runUrl: values['run-url'] }));
    break;
  default:
    console.error(USAGE);
    process.exit(2);
}
