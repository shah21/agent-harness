#!/usr/bin/env node
// Entry for the runner's select job. Prints only counts and indices: this runs where
// logs are public, and project names must not reach them.
import { parseArgs } from 'node:util';
import { githubClient } from './lib/github.mjs';
import { runSharedSelect } from './lib/shared-run.mjs';

const { values } = parseArgs({
  options: { 'store-repo': { type: 'string' }, 'projects-path': { type: 'string' }, out: { type: 'string' } },
});
const need = (name, v) => {
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
};
try {
  const store = githubClient({ token: need('STORE_TOKEN', process.env.STORE_TOKEN) });
  const projectsText = await store.fileContent(need('--store-repo', values['store-repo']), need('--projects-path', values['projects-path']));
  if (projectsText === null) throw new Error('the project list was not found');
  const r = await runSharedSelect({
    projectsText,
    tokensText: need('RUNNER_TOKENS', process.env.RUNNER_TOKENS),
    outDir: need('--out', values.out),
    resume: process.env.EVENT_NAME === 'schedule',
  });
  process.stdout.write(`count=${r.count}\nmore=${r.more}\nmatrix=${JSON.stringify([...Array(r.count).keys()])}\n`);
} catch (e) {
  console.error(`select failed: ${e.message}`);
  process.exit(1);
}
