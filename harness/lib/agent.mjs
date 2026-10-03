export const ALLOWED_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

// The agent must never see a GitHub token; only these variables pass through.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'CI', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function agentEnv(source, extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return { ...env, ...extra };
}

// addDir lets the agent write its report outside the project checkout.
export function agentCommand({ model, maxTurns, promptText, addDir, override }) {
  if (override) return ['sh', '-c', override];
  return [
    'claude', '-p', promptText,
    '--model', model,
    '--max-turns', String(maxTurns),
    '--allowedTools', ALLOWED_TOOLS,
    '--add-dir', addDir,
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

const NO_DEV_SERVERS =
  "Do not start dev servers or watchers yourself; a check command that starts and stops its own server (for example a test runner's web-server option) is fine.";

// The prompt's process rule; projects with a setup command also learn their services are up.
export function servicesRule(hasSetup) {
  return hasSetup ? `Services started by the project's setup command are already running. ${NO_DEV_SERVERS}` : NO_DEV_SERVERS;
}

const TOKEN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2'];

// Accounts in the order they are tried; an empty secret means "not configured".
export function claudeTokens(env) {
  return TOKEN_VARS.map((name) => env[name]).filter(Boolean);
}

// One cheap turn to learn whether an account can work right now.
export function probeCommand({ model, override }) {
  if (override) return ['sh', '-c', override];
  return ['claude', '-p', 'Reply with just: ok', '--model', model, '--max-turns', '1', '--output-format', 'stream-json', '--verbose'];
}

// Only Claude's own result line (or its plain-text banner) counts: a tool call
// that merely mentions "rate_limit" must not look like an exhausted account.
export function detectUsageLimit(text) {
  return String(text)
    .split('\n')
    .some(
      (line) =>
        /^Claude AI usage limit reached/.test(line.trim()) ||
        (line.includes('"type":"result"') && line.includes('"is_error":true') && /usage limit|rate.?limit|"api_error_status":429/i.test(line)),
    );
}

export function detectAuthFailure(text) {
  return /authentication_failed|Invalid bearer token/.test(String(text));
}
