// A fetch stand-in that answers by method and URL pattern and records every call.
export function makeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    for (const h of handlers) {
      if (h.method === method && h.match.test(String(url))) {
        const out = typeof h.reply === 'function' ? h.reply(String(url), init) : h.reply;
        const status = out.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (k) => out.headers?.[String(k).toLowerCase()] ?? null },
          json: async () => out.body,
          text: async () => JSON.stringify(out.body ?? ''),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { fetchImpl, calls };
}
