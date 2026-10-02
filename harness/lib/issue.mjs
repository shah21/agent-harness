export function parseTaskRef(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const plan = /^plan:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  const task = /^task:[ \t]*(\d+)[ \t]*$/m.exec(text)?.[1];
  if (!plan) return { error: 'issue body has no "plan: <path>" line' };
  if (!task) return { error: 'issue body has no "task: <number>" line' };
  if (plan.startsWith('/') || plan.split('/').includes('..')) {
    return { error: `plan path must be relative inside the repo: ${plan}` };
  }
  return { plan, task: Number(task) };
}

export function findTaskHeading(planText, task) {
  const text = String(planText).replace(/\r\n/g, '\n');
  const m = new RegExp(`^#{2,3} Task ${task}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text);
  return m ? m[1] : null;
}
