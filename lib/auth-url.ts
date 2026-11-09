import { safeNextPath } from './safe-next-path.ts';
// SC-020-B: the trusted tenant-host header (set only by proxy.ts) for auth callbacks on customer domains.
export { TENANT_HOST_HEADER, tenantOriginFromHeader } from './tenant-domains.ts';

type AuthEnvironment = {
  NEXT_PUBLIC_SITE_URL?: string; VERCEL_ENV?: string; NODE_ENV?: string;
  VERCEL_BRANCH_URL?: string; VERCEL_URL?: string; VERCEL_PROJECT_PRODUCTION_URL?: string;
};

/** `tenantOrigin` (SC-020-B): origin of an active, verified customer domain, taken ONLY from the
 * header proxy.ts sets after resolving the host in the database (never from the request itself).
 * It is accepted as the request origin in addition to the configured application origins. */
export function appOrigin(requestOrigin?: string | null, env: AuthEnvironment = process.env, tenantOrigin?: string | null) {
  const origins: string[] = [];
  const add = (value: string | undefined, systemHost = false) => {
    if (value === undefined) return;
    if (!value.trim() || /[\s\\]/.test(value)) throw new Error('Nieprawidłowy adres aplikacji.');
    if (systemHost && !/^[a-z0-9.-]+$/i.test(value)) throw new Error('Nieprawidłowy adres wdrożenia.');
    const url = new URL(systemHost ? 'https://' + value : value);
    const local = !env.VERCEL_ENV && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.hostname.includes('*')
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('Nieprawidłowy adres aplikacji.');
    origins.push(url.origin);
  };
  // Preview must never silently fall back to the production app: its PKCE cookie
  // belongs to the origin where the request was made.
  if (env.VERCEL_ENV === 'preview') {
    add(env.VERCEL_BRANCH_URL, true);
    add(env.VERCEL_URL, true);
    if (!origins.length) throw new Error('Brak adresu wersji testowej.');
  } else {
    add(env.NEXT_PUBLIC_SITE_URL);
    if (env.VERCEL_ENV === 'production') add(env.VERCEL_PROJECT_PRODUCTION_URL, true);
    if (!origins.length && !env.VERCEL_ENV && env.NODE_ENV === 'development') add('http://localhost:3000');
    if (!origins.length) throw new Error('Brak adresu aplikacji dla wiadomości e-mail.');
  }
  if (requestOrigin !== undefined && requestOrigin !== null) {
    // Origin is untrusted input. Never accept Host/X-Forwarded-Host as configuration.
    if (tenantOrigin && /^https:\/\/[a-z0-9.-]+$/.test(tenantOrigin) && requestOrigin === tenantOrigin) return requestOrigin;
    if (!origins.includes(requestOrigin)) throw new Error('Otwórz aplikację pod skonfigurowanym adresem.');
    return requestOrigin;
  }
  return origins[0];
}

/** SC-BUY-002: `next` carries the purchase target through e-mail confirmation.
 * It is validated here and AGAIN in the callback, because the confirmation link
 * leaves our control between the two. Recovery links never carry it: a password
 * reset must land on /reset-password and nowhere a stale link could point. */
export function authCallbackUrl(flow: 'signup' | 'recovery', requestOrigin?: string | null, env: AuthEnvironment = process.env, next?: unknown, tenantOrigin?: string | null) {
  const callback = appOrigin(requestOrigin, env, tenantOrigin) + '/auth/callback';
  if (flow === 'recovery') return callback + '?flow=recovery';
  const target = safeNextPath(next);
  return target ? callback + '?next=' + encodeURIComponent(target) : callback;
}
export function callbackDestination(flow: string | null) {
  return flow === "recovery" ? "/reset-password" : "/dashboard";
}

/** Where the home page sends Supabase's Site URL fallback: a PKCE code goes to the callback, an auth
 * error to the login notice; anything else stays on the home page (null).
 *
 * `code` is rebuilt ALONE, on purpose. This is the hardened path for links that
 * FAILED Supabase's redirect allowlist and were rewritten to the Site URL, so
 * every other parameter here is untrusted and is dropped — including the
 * SC-BUY-002 purchase target, which is simply lost on this path. Do not "fix"
 * that by forwarding parameters: a visitor who lands here still reaches the
 * dashboard and can click "Kup PRESELEKCJĘ" again. */
export function homeAuthFallback(params: URLSearchParams): string | null {
  const code = params.get('code');
  if (code && /^[A-Za-z0-9_-]{1,512}$/.test(code)) return '/auth/callback?' + new URLSearchParams({ code });
  if (params.has('error') || params.has('error_code') || code !== null) return '/login?message=callback';
  return null;
}
