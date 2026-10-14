import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReviewPrompt, renderVerifyPrompt } from '../harness/lib/review-inputs.mjs';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'harness');
const finding = { id: 'R1', severity: 'high', file: 'a.txt', line: 3, rule: 'plan-mismatch', problem: 'Wrong.', fix: 'Fix it.' };

test('the review prompt runs the project skill unattended and ranks the task above the plan code', () => {
  const text = renderReviewPrompt(readFileSync(join(HARNESS, 'review-prompt.md'), 'utf8'), {
    round: 1, goal: '**Goal:** Parse ages.', skillDir: '/out/review-skill', planTask: '## Task 1: x', diff: 'd',
    rules: [], contexts: [], history: '(first review)', outputPath: '/out/review-1.md',
  });
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, /Read \/out\/review-skill\/SKILL\.md first/);
  assert.match(text, /Skip every step that asks a human, waits for approval, posts to GitHub or files an issue/);
  assert.match(text, /blocker, critical, high → high/);
  assert.match(text, /Code that matches the plan proves nothing/);
  assert.match(text, /A defect copied from the plan is still a finding/);
  assert.match(text, /You may run commands/);
  assert.match(text, /inside a changed hunk/);
  assert.match(text, /<untrusted-data name="plan-goal">\n\*\*Goal:\*\* Parse ages\.\n<\/untrusted-data>/);
});

test('the verify prompt asks for a refutation per finding', () => {
  const text = renderVerifyPrompt(readFileSync(join(HARNESS, 'verify-prompt.md'), 'utf8'), {
    round: 2, skillDir: '/out/review-skill', planTask: '## Task 1: x', diff: 'd', findings: [finding], outputPath: '/out/verify-2.md',
  });
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, /verification for review round 2/);
  assert.match(text, /R1: CONFIRMED\nR2: WITHDRAWN: </);
  assert.match(text, /Withdraw only with evidence\. When unsure, confirm\./);
  assert.match(text, /can never execute/);
  assert.match(text, /<untrusted-data name="findings">\n- R1 \(high\) a\.txt:3 plan-mismatch: Wrong\./);
  assert.match(text, /\/out\/verify-2\.md/);
});
