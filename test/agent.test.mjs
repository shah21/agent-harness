import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentEnv, agentCommand, renderPrompt, ALLOWED_TOOLS, claudeTokens, probeCommand, detectUsageLimit, detectAuthFailure } from '../harness/lib/agent.mjs';

test('agentEnv keeps only allowlisted variables plus extras', () => {
  const env = agentEnv(
    { PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'tok', GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh', ACTIONS_RUNTIME_TOKEN: 'rt' },
    { REPORT_PATH: '/r' },
  );
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'tok', REPORT_PATH: '/r' });
});

test('agentCommand builds the claude invocation', () => {
  assert.equal(ALLOWED_TOOLS, 'Read,Edit,Write,Glob,Grep,Bash');
  assert.deepEqual(agentCommand({ model: 'sonnet', maxTurns: 150, promptText: 'do it', addDir: '/out' }), [
    'claude', '-p', 'do it', '--model', 'sonnet', '--max-turns', '150',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash', '--add-dir', '/out',
    '--output-format', 'stream-json', '--verbose',
  ]);
});

test('AGENT_CMD override replaces claude', () => {
  assert.deepEqual(agentCommand({ model: 'sonnet', maxTurns: 1, promptText: 'x', override: 'sh fake.sh' }), ['sh', '-c', 'sh fake.sh']);
});

test('renderPrompt substitutes and rejects unknown variables', () => {
  assert.equal(renderPrompt('Task {{TASK}} of {{PLAN}}', { TASK: 3, PLAN: 'p.md' }), 'Task 3 of p.md');
  assert.throws(() => renderPrompt('{{NOPE}}', {}), /unknown variable NOPE/);
});

test('the shipped prompt uses only the documented variables', () => {
  const template = readFileSync(new URL('../harness/prompt.md', import.meta.url), 'utf8');
  const out = renderPrompt(template, {
    ISSUE: 7, PLAN: 'docs/p.md', TASK: 1, TASK_TITLE: 'Add greeting', REPORT_PATH: '/tmp/report.md',
    BRANCH: 'agent/issue-7', CHECKS: '- test: `npm test`', CHECKS_REPORT: '- test: PASS', PROTECTED: '`.github/**`',
  });
  assert.match(out, /\/tmp\/report\.md/);
  assert.match(out, /^CHECKS:\n- test: PASS$/m);
  assert.doesNotMatch(out, /\{\{/);
});

test('claudeTokens lists configured tokens in order, skipping empty ones', () => {
  assert.deepEqual(claudeTokens({ CLAUDE_CODE_OAUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN_2: 'b' }), ['a', 'b']);
  assert.deepEqual(claudeTokens({ CLAUDE_CODE_OAUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN_2: '' }), ['a']);
  assert.deepEqual(claudeTokens({ CLAUDE_CODE_OAUTH_TOKEN_2: 'b' }), ['b']);
  assert.deepEqual(claudeTokens({}), []);
});

test('agentEnv never passes the second token through', () => {
  const env = agentEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN_2: 'b' }, { CLAUDE_CODE_OAUTH_TOKEN: 'b' });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'b' });
});

test('probeCommand is a one-turn claude call, overridable for tests', () => {
  assert.deepEqual(probeCommand({ model: 'sonnet' }), [
    'claude', '-p', 'Reply with just: ok', '--model', 'sonnet', '--max-turns', '1', '--output-format', 'stream-json', '--verbose',
  ]);
  assert.deepEqual(probeCommand({ model: 'sonnet', override: 'true' }), ['sh', '-c', 'true']);
});

test('detectUsageLimit matches result-line limit errors only', () => {
  assert.equal(detectUsageLimit('{"type":"result","is_error":true,"api_error_status":429,"result":"x"}'), true);
  assert.equal(detectUsageLimit('{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1790000000"}'), true);
  assert.equal(detectUsageLimit('Claude AI usage limit reached|1790000000'), true);
  assert.equal(detectUsageLimit('{"type":"user","content":"grep rate_limit src/"}'), false);
  assert.equal(detectUsageLimit('{"type":"result","is_error":false,"result":"done"}'), false);
});

test('detectAuthFailure matches 401 errors', () => {
  assert.equal(detectAuthFailure('{"error":"authentication_failed"}'), true);
  assert.equal(detectAuthFailure('API Error: 401 Invalid bearer token'), true);
  assert.equal(detectAuthFailure('all good'), false);
});
