const ALWAYS_PROTECTED = ['.github/**', 'agent.config.json'];
const DEFAULTS = {
  model: 'sonnet',
  maxTurns: 150,
  timeouts: { install: '15m', claude: '45m', check: '10m' },
  testGlobs: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**'],
};

export function parseDuration(value) {
  const m = /^(\d+)(s|m|h)$/.exec(String(value));
  if (!m || Number(m[1]) === 0) throw new Error(`invalid duration "${value}" (use e.g. 30s, 10m, 1h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  return value;
}

export function loadConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object');
  if (typeof raw.install !== 'string' || !raw.install.trim()) throw new Error('"install" must be a non-empty string');

  const checks = raw.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || Object.keys(checks).length === 0) {
    throw new Error('"checks" must be an object with at least one check');
  }
  for (const [name, cmd] of Object.entries(checks)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`check name "${name}" must be lowercase letters, digits, - or _`);
    if (typeof cmd !== 'string' || !cmd.trim()) throw new Error(`check "${name}" must be a non-empty command string`);
  }

  const model = raw.model ?? DEFAULTS.model;
  if (typeof model !== 'string' || !model) throw new Error('"model" must be a non-empty string');
  const maxTurns = raw.maxTurns ?? DEFAULTS.maxTurns;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('"maxTurns" must be a positive integer');

  const t = { ...DEFAULTS.timeouts, ...(raw.timeouts ?? {}) };
  const timeouts = { install: parseDuration(t.install), claude: parseDuration(t.claude), check: parseDuration(t.check) };

  return {
    install: raw.install,
    checks: { ...checks },
    model,
    maxTurns,
    timeouts,
    protectedPaths: [...new Set([...ALWAYS_PROTECTED, ...stringArray(raw.protectedPaths, 'protectedPaths')])],
    testGlobs: raw.testGlobs === undefined ? DEFAULTS.testGlobs : stringArray(raw.testGlobs, 'testGlobs'),
  };
}
