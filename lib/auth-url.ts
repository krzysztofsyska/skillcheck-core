type AuthEnvironment = {
  NEXT_PUBLIC_SITE_URL?: string; VERCEL_ENV?: string; NODE_ENV?: string;
  VERCEL_BRANCH_URL?: string; VERCEL_URL?: string; VERCEL_PROJECT_PRODUCTION_URL?: string;
};

export function appOrigin(requestOrigin?: string | null, env: AuthEnvironment = process.env) {
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
    if (!origins.includes(requestOrigin)) throw new Error('Otwórz aplikację pod skonfigurowanym adresem.');
    return requestOrigin;
  }
  return origins[0];
}

export function authCallbackUrl(flow: 'signup' | 'recovery', requestOrigin?: string | null, env: AuthEnvironment = process.env) {
  return appOrigin(requestOrigin, env) + '/auth/callback' + (flow === 'recovery' ? '?flow=recovery' : '');
}
export function callbackDestination(flow: string | null) {
  return flow === "recovery" ? "/reset-password" : "/dashboard";
}
