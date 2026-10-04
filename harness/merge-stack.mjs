#!/usr/bin/env node
// Merge a stack of agent PRs in the safe order: bottom-up, retargeting each PR to the
// default branch first, deleting branches only after the last merge.
//   node merge-stack.mjs [--repo owner/name]          list the order (dry run)
//   node merge-stack.mjs [--repo owner/name] --yes    merge
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mergeStacks } from './lib/merge-stack.mjs';

const exec = promisify(execFile);
const run = async (args) => (await exec('gh', args, { maxBuffer: 10 * 1024 * 1024 })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { values } = parseArgs({ options: { repo: { type: 'string' }, yes: { type: 'boolean', default: false } } });
const repo = values.repo ?? (await run(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
const defaultBranch = (await run(['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'])).trim();

const result = await mergeStacks({ repo, defaultBranch, yes: values.yes, run, sleep });
process.exit(result.ok ? 0 : 1);
