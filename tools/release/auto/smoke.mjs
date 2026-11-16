// Post-deploy smoke test of production. Read-only GET requests; no login with real accounts,
// no payments, no contact with anyone. Each check gets a few attempts (CDN propagation).
export async function runSmoke({ baseUrl, checks, fetchImpl = fetch, sleep, attempts = 3, delayMs = 20000 }) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(baseUrl ?? '') || !Array.isArray(checks) || !checks.length) {
    return { ok: false, failures: ['SMOKE_CONFIG_INVALID'] };
  }
  const failures = [];
  for (const check of checks) {
    let last = 'NOT_RUN';
    for (let i = 0; i < attempts; i++) {
      last = await one(fetchImpl, baseUrl, check);
      if (last === null) break;
      if (i < attempts - 1) await sleep(delayMs);
    }
    if (last !== null) failures.push(`${check.path}:${last}`);
  }
  return { ok: failures.length === 0, failures };
}

async function one(fetchImpl, baseUrl, check) {
  try {
    const res = await fetchImpl(`${baseUrl}${check.path}`, { redirect: 'manual', headers: { 'cache-control': 'no-cache', 'user-agent': 'skillcheck-auto-release-smoke' } });
    if (res.status !== (check.status ?? 200)) return `STATUS_${res.status}`;
    const text = await res.text();
    if (check.contains && !text.includes(check.contains)) return 'CONTENT_MISSING';
    if (check.json) {
      let body; try { body = JSON.parse(text); } catch { return 'JSON_INVALID'; }
      for (const [k, v] of Object.entries(check.json)) if (body?.[k] !== v) return `JSON_${k}_MISMATCH`;
    }
    return null;
  } catch {
    return 'NETWORK_ERROR';
  }
}
