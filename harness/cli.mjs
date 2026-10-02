#!/usr/bin/env node
// Small commands the reusable workflow calls between gh steps.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { selectNext } from './lib/queue.mjs';
import { renderPrBody, renderComment } from './lib/format.mjs';

const USAGE = `usage:
  cli.mjs select --issues <f> --prs <f> --default-branch <b>
  cli.mjs skip-verdict --selection <f>
  cli.mjs fallback-verdict --selection <f>
  cli.mjs render-pr --verdict <f>
  cli.mjs render-comment --verdict <f> --run-url <u> [--pr-url <u>]`;

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

const [command, ...rest] = process.argv.slice(2);
let values;
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      issues: { type: 'string' }, prs: { type: 'string' }, 'default-branch': { type: 'string' },
      selection: { type: 'string' }, verdict: { type: 'string' },
      'run-url': { type: 'string' }, 'pr-url': { type: 'string' },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}

switch (command) {
  case 'select':
    print(selectNext({ issues: read(values.issues), prs: read(values.prs), defaultBranch: values['default-branch'] }));
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
    process.stdout.write(renderComment(read(values.verdict), { runUrl: values['run-url'], prUrl: values['pr-url'] }));
    break;
  default:
    console.error(USAGE);
    process.exit(2);
}
