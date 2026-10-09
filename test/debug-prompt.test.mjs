import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPrompt, agentCommand, ALLOWED_TOOLS } from '../harness/lib/agent.mjs';

const template = readFileSync(new URL('../harness/debug-prompt.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../harness/debug/systematic-debugging/SKILL.md', import.meta.url), 'utf8');

const VARS = ['ISSUE', 'ISSUE_TITLE', 'TARGET_SECTION', 'REPORT_PATH', 'SERVICES_RULE', 'SKILL', 'CONTEXT_PATHS', 'SYMPTOM', 'CONTEXT_NAME', 'CONTEXT_TEXT'];

test('the template uses exactly the documented variables', () => {
  const used = [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, [...VARS].sort());
});

test('rendering fills every variable and keeps the report field names', () => {
  const vars = Object.fromEntries(VARS.map((v) => [v, `<<${v}>>`]));
  const out = renderPrompt(template, vars);
  for (const v of VARS) assert.match(out, new RegExp(`<<${v}>>`), v);
  assert.doesNotMatch(out, /\{\{/);
  for (const k of ['STATUS', 'PROBLEM', 'REPRODUCTION', 'EVIDENCE', 'HYPOTHESES', 'ROOT_CAUSE', 'OWNING_MODULE', 'NEXT_ACTION', 'UNKNOWNS', 'HUMAN_INPUT_NEEDED']) {
    assert.match(out, new RegExp(`^${k}:`, 'm'), k);
  }
  assert.match(out, /read-only/i);
});

test('the vendored skill is read-only and non-interactive', () => {
  assert.match(skill, /NO CONCLUSION WITHOUT EVIDENCE/);
  assert.doesNotMatch(skill, /human partner/i);
  assert.doesNotMatch(skill, /superpowers:/);
  assert.doesNotMatch(skill, /Implement (?:Single )?Fix|Create Failing Test/i);
});

test('agentCommand keeps the implementation tools by default and accepts a narrower set', () => {
  const base = { model: 'sonnet', maxTurns: 5, promptText: 'p', addDir: '/tmp/x' };
  const argAfter = (cmd, flag) => cmd[cmd.indexOf(flag) + 1];
  assert.equal(argAfter(agentCommand(base), '--allowedTools'), ALLOWED_TOOLS);
  assert.equal(argAfter(agentCommand({ ...base, tools: 'Read,Grep' }), '--allowedTools'), 'Read,Grep');
});
