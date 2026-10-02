export const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

// The agent must never see a GitHub token; only these variables pass through.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'CI', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function agentEnv(source, extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...extra };
}

export function agentCommand({ model, maxTurns, promptText, override }) {
  if (override) return ['sh', '-c', override];
  return [
    'claude', '-p', promptText,
    '--model', model,
    '--max-turns', String(maxTurns),
    '--allowedTools', ALLOWED_TOOLS,
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

export function renderPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`prompt template uses unknown variable ${name}`);
    return String(vars[name]);
  });
}
