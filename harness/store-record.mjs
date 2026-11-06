#!/usr/bin/env node
// Writes the trimmed record of one run to the private store. Prints nothing on success and a
// fixed message on failure: this runs where logs are public.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { githubClient } from './lib/github.mjs';
import { buildRecord, recordPath } from './lib/record.mjs';

const { values } = parseArgs({ options: { verdict: { type: 'string' }, entry: { type: 'string' }, 'run-id': { type: 'string' } } });
try {
  const record = buildRecord({
    verdict: JSON.parse(readFileSync(values.verdict, 'utf8')),
    entry: JSON.parse(readFileSync(values.entry, 'utf8')),
    runId: values['run-id'],
  });
  const store = githubClient({ token: process.env.STORE_TOKEN });
  await store.putFile(process.env.STORE_REPO, recordPath(record), `${JSON.stringify(record, null, 2)}\n`, `runner: record ${record.runner.run}-${record.runner.index}`);
} catch {
  console.error('recording the run failed');
  process.exit(1);
}
