// Minimal GitHub REST client for the publisher. Token comes from the trusted workflow.
const API = 'https://api.github.com';
const MAX_PAGES = 20;

// `token` is a string or an async function returning a fresh token (refreshed by the caller).
export function createGithub({ token, repository, fetchImpl = fetch }) {
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('GITHUB_CONFIG_INVALID');
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'skillcheck-auto-release',
  };
  async function call(method, path, body) {
    const url = path.startsWith('http') ? path : `${API}${path.startsWith('/repos') ? '' : `/repos/${repository}`}${path}`;
    const auth = typeof token === 'function' ? await token() : token;
    const res = await fetchImpl(url, { method, headers: { ...headers, authorization: `Bearer ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = new Error(`GITHUB_${method}_${res.status}:${path}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return { json, link: res.headers.get?.('link') ?? '' };
  }
  async function paginate(path, pick = x => x) {
    const out = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    for (let i = 0; next; i++) {
      if (i >= MAX_PAGES) throw new Error(`GITHUB_PAGINATION_LIMIT:${path}`);
      const { json, link } = await call('GET', next);
      out.push(...pick(json));
      const m = /<([^>]+)>;\s*rel="next"/.exec(link ?? '');
      next = m ? m[1] : null;
    }
    return out;
  }
  return {
    repository,
    get: path => call('GET', path).then(r => r.json),
    post: (path, body) => call('POST', path, body).then(r => r.json),
    put: (path, body) => call('PUT', path, body).then(r => r.json),
    patch: (path, body) => call('PATCH', path, body).then(r => r.json),
    paginate,
  };
}
