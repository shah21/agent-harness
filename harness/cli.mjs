#!/usr/bin/env node
// Small commands the reusable workflow calls between gh steps.
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { selectNext, selectDebug, targetsToCheck } from './lib/queue.mjs';
import { renderPrBody, renderComment, renderReviewRound, renderReviewSummary } from './lib/format.mjs';
import { renderDebugComment } from './lib/debug-comment.mjs';
import { issueToClose } from './lib/merged.mjs';
import { loadConfig } from './lib/config.mjs';
import { selectReview, buildReviewSelection, checkoutPlan } from './lib/pr-review.mjs';
import { mergeIssueBody, renderReviewBlocked } from './lib/pr-review-format.mjs';
import { parseGitmodules } from './lib/target.mjs';
import {
  encryptDir, decryptToDir, sealDir, openSealed, generateKeypair, tagFor, proofFor, verifyProof, CryptError,
} from './lib/crypt.mjs';
import { createHash } from 'node:crypto';
import { parseBlocklist, scanDir, scanText } from './lib/leak.mjs';
import { guardVerdict } from './lib/verdict-guard.mjs';
import { renderSharedWorkflow } from './lib/shared-workflow.mjs';
import { planSubmodules, verifyRegisteredSubmodules } from './lib/submodules.mjs';

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
  cli.mjs review-fallback-verdict --selection <f>
  cli.mjs render-pr-review --verdict <f> --body <f> --run-url <u>
  cli.mjs render-review-blocked --verdict <f> --run-url <u>
  cli.mjs shared-entry --selections <f> --index <n> --out <dir>
  cli.mjs encrypt --dir <d> --out <f> [--aad <s>]   (key in env RUN_KEY)
  cli.mjs decrypt --in <f> --dir <d> [--aad <s>]    (key in env RUN_KEY)
  cli.mjs leak-scan --blocklist <f> [--root <d>]... [--file <f>]...
  cli.mjs guard-verdict --verdict <f> --entry <f> --bundle-dir <d>
  cli.mjs submodule-plan --entry <f> --gitmodules <f>
  cli.mjs submodule-verify --entry <f> --repo-dir <dir>
  cli.mjs gen-shared-workflow --out <f>       (writes .github/workflows/run-shared.yml)
  cli.mjs keygen --out <dir>                  (writes public.key and private.key)
  cli.mjs seal --dir <d> --out <f> [--key-file <f>] [--aad <s>] [--allow-links]   (key in env SEAL_PUBLIC_KEY)
  cli.mjs open --in <f> --dir <d> [--key-file <f>] [--aad <s>] [--allow-links]    (key in env OPEN_PRIVATE_KEY)
  cli.mjs tag --run-id <id> --label <l>       (secret in env SLOT_KEY)
  cli.mjs proof --run-id <id> --slot <n> --label <l> [--data-file <f>]        (secret in env SLOT_KEY)
  cli.mjs proof-check --run-id <id> --slot <n> --label <l> [--data-file <f>] --proof-file <f>`;

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
      selections: { type: 'string' }, index: { type: 'string' }, dir: { type: 'string' }, in: { type: 'string' },
      slot: { type: 'string' }, 'data-file': { type: 'string' }, 'proof-file': { type: 'string' }, 'repo-dir': { type: 'string' }, gitmodules: { type: 'string' }, entry: { type: 'string' }, 'bundle-dir': { type: 'string' }, 'key-file': { type: 'string' }, 'allow-links': { type: 'boolean' }, label: { type: 'string' }, 'run-id': { type: 'string' },
      aad: { type: 'string' }, blocklist: { type: 'string' }, root: { type: 'string', multiple: true }, file: { type: 'string', multiple: true },
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
  case 'render-pr-review':
    process.stdout.write(mergeIssueBody(readFileSync(values.body, 'utf8'), read(values.verdict), { runUrl: values['run-url'] }));
    break;
  case 'render-review-blocked':
    process.stdout.write(renderReviewBlocked(read(values.verdict), { runUrl: values['run-url'] }));
    break;
  case 'shared-entry': {
    const entry = read(values.selections)[Number(values.index)];
    if (!entry) {
      console.error('no such selection');
      process.exit(1);
    }
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
    writeFileSync(join(values.out, 'selection.json'), `${JSON.stringify(entry.selection, null, 2)}\n`);
    writeFileSync(join(values.out, 'issue.json'), `${JSON.stringify(entry.selection.issue, null, 2)}\n`);
    // Step outputs and env values can be printed in a public log: only the flag a step needs.
    process.stdout.write(`skipped=${entry.selection.skip ? 'true' : 'false'}\n`);
    break;
  }
  case 'encrypt':
  case 'decrypt':
    try {
      const opts = values.aad === undefined ? {} : { aad: values.aad };
      if (command === 'encrypt') await encryptDir(values.dir, values.out, process.env.RUN_KEY, opts);
      else await decryptToDir(values.in, values.dir, process.env.RUN_KEY, opts);
    } catch (e) {
      console.error(e instanceof CryptError ? e.message : `${command === 'encrypt' ? 'encryption' : 'decryption'} failed`);
      process.exit(1);
    }
    break;
  case 'gen-shared-workflow':
    writeFileSync(values.out, renderSharedWorkflow());
    break;
  case 'submodule-plan':
  case 'submodule-verify':
    // Lists the submodule paths to initialise, or checks the URLs git registered, against the
    // owner's allow-list. Git does the reading, so the two cannot disagree.
    try {
      const allow = read(values.entry).target?.allow ?? [];
      if (command === 'submodule-plan') {
        const paths = planSubmodules(values.gitmodules, allow);
        for (const x of paths) process.stdout.write(`${x}\n`);
      } else {
        verifyRegisteredSubmodules(values['repo-dir'], allow);
      }
    } catch {
      console.error('submodule not allowed');
      process.exit(1);
    }
    break;
  case 'guard-verdict': {
    let text;
    try {
      text = readFileSync(values.verdict, 'utf8');
    } catch {
      console.error('no verdict to check');
      process.exit(1);
    }
    const entry = read(values.entry);
    let parsed;
    try {
      parsed = text.length > 5_000_000 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    // A bundle is a regular file that starts like a git bundle: not a directory (git would fetch
    // from the repository inside it) and not a link.
    const isBundle = (p) => {
      try {
        if (!lstatSync(p).isFile()) return false;
        const fd = openSync(p, 'r');
        const head = Buffer.alloc(16);
        readSync(fd, head, 0, 16, 0);
        closeSync(fd);
        return /^# v[23] git bundle\n/.test(head.toString('latin1'));
      } catch {
        return false;
      }
    };
    const checked = guardVerdict({ verdict: parsed, entry, bundleDir: values['bundle-dir'], isBundle });
    if (checked.ok) print(checked.verdict);
    else print(blockedVerdict(entry.selection, 'harness', checked.reason));
    break;
  }
  case 'keygen': {
    const { publicKey, privateKey } = generateKeypair();
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'public.key'), `${publicKey}\n`);
    writeFileSync(join(values.out, 'private.key'), `${privateKey}\n`, { mode: 0o600 });
    break;
  }
  case 'seal':
  case 'open':
    try {
      const sealing = command === 'seal';
      const fromEnv = process.env[sealing ? 'SEAL_PUBLIC_KEY' : 'OPEN_PRIVATE_KEY'];
      const key = values['key-file'] ? readFileSync(values['key-file'], 'utf8').trim() : fromEnv;
      if (!key) throw new CryptError(`${sealing ? 'public' : 'private'} key missing`);
      const opts = { allowLinks: values['allow-links'] === true, ...(values.aad === undefined ? {} : { aad: values.aad }) };
      if (sealing) await sealDir(values.dir, values.out, key, opts);
      else await openSealed(values.in, values.dir, key, opts);
    } catch (e) {
      console.error(e instanceof CryptError ? e.message : `${command === 'seal' ? 'encryption' : 'decryption'} failed`);
      process.exit(1);
    }
    break;
  case 'proof':
  case 'proof-check':
    try {
      const data = values['data-file'] ? createHash('sha256').update(readFileSync(values['data-file'])).digest('hex') : 'none';
      const parts = [values['run-id'], values.slot, values.label, data];
      if (command === 'proof') {
        process.stdout.write(`${proofFor(process.env.SLOT_KEY, ...parts)}\n`);
      } else if (!verifyProof(process.env.SLOT_KEY, readFileSync(values['proof-file'], 'utf8').trim(), ...parts)) {
        process.exit(1);
      }
    } catch (e) {
      console.error(e instanceof CryptError ? e.message : 'proof failed');
      process.exit(1);
    }
    break;
  case 'tag':
    try {
      process.stdout.write(`${tagFor(process.env.SLOT_KEY, values['run-id'], values.label)}\n`);
    } catch (e) {
      console.error(e instanceof CryptError ? e.message : 'tag failed');
      process.exit(1);
    }
    break;
  case 'leak-scan': {
    const terms = parseBlocklist(readFileSync(values.blocklist, 'utf8'));
    const hits = [
      ...(values.root ?? []).flatMap((r) => scanDir(r, terms)),
      ...(values.file ?? []).flatMap((f) => scanText(f, readFileSync(f, 'utf8'), terms)),
    ];
    for (const h of hits) process.stdout.write(`${h.path}:${h.line}\n`);
    if (hits.length > 0) process.exit(1);
    break;
  }
  default:
    console.error(USAGE);
    process.exit(2);
}
