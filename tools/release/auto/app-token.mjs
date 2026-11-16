// Installation token of the existing pipeline GitHub App, minted in-process and refreshed before
// it expires (installation tokens live 1 hour; one publisher run can take up to ~2 hours).
// The private key and the tokens are never logged.
import { createSign } from 'node:crypto';

const REFRESH_BEFORE_MS = 15 * 60 * 1000;

function appJwt(appId, privateKey, nowMs) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(nowMs / 1000) - 60;
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 540, iss: String(appId) })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
}

export function createAppTokenProvider({ appId, installationId, privateKey, fetchImpl = fetch, now = () => Date.now(), onToken = () => {} }) {
  if (!/^\d+$/.test(String(appId ?? '')) || !/^\d+$/.test(String(installationId ?? '')) || !privateKey) throw new Error('APP_CONFIG_MISSING');
  let cached = null;
  const headers = jwt => ({ authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'skillcheck-auto-release' });
  async function token() {
    if (cached && cached.expiresAt - now() > REFRESH_BEFORE_MS) return cached.token;
    const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: headers(appJwt(appId, privateKey, now())) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token) throw new Error(`APP_TOKEN_FAILED:${res.status}`);
    onToken(body.token);
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) || now() + 3600000 };
    return cached.token;
  }
  async function slug() {
    const res = await fetchImpl('https://api.github.com/app', { headers: headers(appJwt(appId, privateKey, now())) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !/^[a-z0-9-]+$/.test(body?.slug ?? '')) throw new Error(`APP_SLUG_FAILED:${res.status}`);
    return body.slug;
  }
  return { token, slug };
}
