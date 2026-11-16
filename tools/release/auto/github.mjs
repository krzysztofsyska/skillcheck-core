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
  // Resolved/unresolved state of review conversations exists only in GraphQL; REST cannot
  // answer it. Read only, fixed query, fail closed: any error or partial page throws, and
  // the policy then refuses the release for want of evidence.
  async function reviewThreads(number) {
    if (!Number.isInteger(number) || number <= 0) throw new Error('REVIEW_THREADS_PR_INVALID');
    const [owner, repo] = repository.split('/');
    const query = `query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor}nodes{isResolved isOutdated comments(first:1){nodes{path}}}}}}}`;
    const out = []; let cursor = null; const cursors = new Set();
    for (let i = 0; i < 20; i++) {
      if (cursor !== null && cursors.has(cursor)) throw new Error('REVIEW_THREADS_CURSOR_LOOP');
      if (cursor !== null) cursors.add(cursor);
      const { json } = await call('POST', 'https://api.github.com/graphql', { query, variables: { o: owner, r: repo, n: number, c: cursor } });
      const t = json?.data?.repository?.pullRequest?.reviewThreads;
      if (json?.errors?.length || !t || !Array.isArray(t.nodes) || typeof t.pageInfo?.hasNextPage !== 'boolean') throw new Error('REVIEW_THREADS_INCOMPLETE');
      for (const n of t.nodes) {
        out.push({ resolved: n?.isResolved === true, outdated: n?.isOutdated === true, path: n?.comments?.nodes?.[0]?.path ?? null });
      }
      if (!t.pageInfo.hasNextPage) return out;
      cursor = t.pageInfo.endCursor;
    }
    throw new Error('REVIEW_THREADS_PAGINATION_LIMIT');
  }
  return {
    repository,
    reviewThreads,
    get: path => call('GET', path).then(r => r.json),
    post: (path, body) => call('POST', path, body).then(r => r.json),
    put: (path, body) => call('PUT', path, body).then(r => r.json),
    patch: (path, body) => call('PATCH', path, body).then(r => r.json),
    paginate,
  };
}
