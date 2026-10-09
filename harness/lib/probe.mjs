import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithTimeout } from './run-cmd.mjs';
import { agentEnv, probeCommand, detectUsageLimit, detectAuthFailure } from './agent.mjs';

// Try each configured account with one cheap turn; returns the ones that work.
export async function probeAccounts({ tokens, model, env, projectDir, logsDir }) {
  const usable = [];
  let limited = 0;
  for (const [i, token] of tokens.entries()) {
    const logFile = join(logsDir, `probe-${i + 1}.log`);
    const r = await runWithTimeout(probeCommand({ model, override: env.AGENT_PROBE_CMD }), {
      cwd: projectDir, timeoutSec: 120, logFile, env: agentEnv(env, { CLAUDE_CODE_OAUTH_TOKEN: token }),
    });
    const text = readFileSync(logFile, 'utf8');
    if (detectUsageLimit(text)) limited++;
    else if (r.exitCode === 0 && !r.timedOut && !detectAuthFailure(text)) usable.push({ token, account: i + 1 });
  }
  return { usable, limited };
}
