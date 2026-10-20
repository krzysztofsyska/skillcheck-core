/**
 * SC-014-B3 HTTP trust boundary. Injected dependencies permit isolated
 * PostgreSQL16/HTTPS tests without enabling any deployed environment.
 * No server-side candidate storage, public RPC, AI, or B4 page.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { executeCompetencyOperation, type CompetencyConnection, type CompetencyOperation } from './competency-attempt-transport.ts';
import { LIMIT_WINDOW_SECONDS, type SharedRateLimiter } from './competency-broker-limiter.ts';

export const B3_ENDPOINT = '/api/competency/attempt';
export const B3_SESSION_COOKIE = '__Secure-sc014_b3_session';
export const B3_INIT_COOKIE = '__Secure-sc014_b3_preflight';
export const B3_MAX_BODY = 128 * 1024;
const B3_COOKIE_PATH = B3_ENDPOINT;
const COOKIE_LIFETIME_AFTER_START_BY_SECONDS = 180 * 60 + 15 * 60;
const MAX_COOKIE_AGE_SECONDS = 7 * 24 * 3600 + COOKIE_LIFETIME_AFTER_START_BY_SECONDS + 60;
const CAPABILITY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GatewayLease extends CompetencyConnection {
  release(destroy?: boolean): void;
}
export interface CompetencyBrokerDependencies {
  enabled: boolean;
  expectedOrigin: string;
  csrfKey: Buffer;
  sourceKey: Buffer;
  limiter: SharedRateLimiter;
  acquire(): Promise<GatewayLease>;
  trustedSource(request: Request): string | null;
  now?(): number;
  maxInFlight?: number;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function response(status: number, payload: Record<string, unknown>, cookies: string[] = []): Response {
  const r = Response.json(payload, { status, headers: SECURITY_HEADERS });
  for (const cookie of cookies) r.headers.append('Set-Cookie', cookie);
  return r;
}
export function competencyBrokerMethodDenied(): Response {
  return response(405, { error: 'method_not_allowed' });
}
function cookieHeader(name: string, value: string, maxAge: number): string {
  return name + '=' + value + '; Path=' + B3_COOKIE_PATH +
    '; Max-Age=' + String(maxAge) + '; Secure; HttpOnly; SameSite=Strict';
}
function exactCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let value: string | null = null;
  for (const piece of header.split(';')) {
    const part = piece.trim();
    if (!part.startsWith(name + '=')) continue;
    if (value !== null) throw new Error('Duplicate cookie');
    value = part.slice(name.length + 1);
    if (!CAPABILITY.test(value)) throw new Error('Invalid cookie');
  }
  return value;
}
function hmac(key: Buffer, label: string, value: string): string {
  return createHmac('sha256', key).update(label + '\0' + value).digest('hex');
}
function equalSecret(a: string | null, b: string): boolean {
  if (!a || !CAPABILITY.test(a) || !CAPABILITY.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function allowedHeaders(request: Request): boolean {
  let total = 0;
  for (const [name, value] of request.headers) {
    total += name.length + value.length;
    if (value.length > 2048 || total > 8192) return false;
  }
  if ((request.headers.get('cookie') || '').length > 1024) return false;
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) return false;
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return false;
  const len = request.headers.get('content-length');
  if (len !== null && (!/^\d{1,6}$/.test(len) || Number(len) > B3_MAX_BODY)) return false;
  return true;
}
function sameOrigin(request: Request, expectedOrigin: string): boolean {
  try {
    const expected = new URL(expectedOrigin);
    const actual = new URL(request.url);
    return expected.protocol === 'https:' &&
      expected.pathname === '/' && !expected.search && !expected.hash &&
      actual.origin === expected.origin && actual.pathname === B3_ENDPOINT &&
      request.headers.get('origin') === expected.origin &&
      (request.headers.get('sec-fetch-site') === null || request.headers.get('sec-fetch-site') === 'same-origin') &&
      (request.headers.get('sec-fetch-mode') === null || request.headers.get('sec-fetch-mode') === 'cors');
  } catch {
    return false;
  }
}
async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const timeout = AbortSignal.timeout(4000);
  const timedOut = timedOut;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Body timeout')), { once: true }))
      ]);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > B3_MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError('Body too large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error('Empty request');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(decoded) as unknown;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
type Parsed =
  | { operation: 'bootstrap' }
  | { operation: 'exchange'; token: string }
  | { operation: 'inspect' | 'status' }
  | { operation: 'start'; requestKey: string }
  | { operation: 'save'; draft: string; expectedVersion: number; requestKey: string }
  | { operation: 'submit'; answer: {workSample: string}; requestKey: string };
function parse(value: unknown): Parsed | null {
  if (!object(value) || typeof value.operation !== 'string') return null;
  switch (value.operation) {
    case 'bootstrap': return exactKeys(value, ['operation']) ? { operation: 'bootstrap' } : null;
    case 'exchange':
      return exactKeys(value, ['operation','token']) && typeof value.token === 'string' && CAPABILITY.test(value.token)
        ? { operation: 'exchange', token: value.token } : null;
    case 'inspect': case 'status':
      return exactKeys(value, ['operation']) ? { operation: value.operation } : null;
    case 'start':
      return exactKeys(value, ['operation','requestKey']) &&
        typeof value.requestKey === 'string' && UUID.test(value.requestKey)
        ? { operation: 'start', requestKey: value.requestKey } : null;
    case 'save':
      return exactKeys(value, ['operation','draft','expectedVersion','requestKey']) &&
        typeof value.draft === 'string' && value.draft.length <= 40000 &&
        Number.isSafeInteger(value.expectedVersion) && (value.expectedVersion as number) >= 0 &&
        typeof value.requestKey === 'string' && UUID.test(value.requestKey)
        ? { operation: 'save', draft: value.draft, expectedVersion: value.expectedVersion as number, requestKey: value.requestKey } : null;
    case 'submit':
      return exactKeys(value, ['operation','answer','requestKey']) &&
        object(value.answer) && exactKeys(value.answer, ['workSample']) &&
        typeof value.answer.workSample === 'string' && value.answer.workSample.length <= 40000 &&
        typeof value.requestKey === 'string' && UUID.test(value.requestKey)
        ? { operation: 'submit', answer: {workSample: value.answer.workSample}, requestKey: value.requestKey } : null;
    default: return null;
  }
}
/** The broker projects SQL output into the B1 allowlist, never forwards a raw DB row. */
function project(kind: Parsed['operation'], raw: unknown): Record<string, unknown> {
  if (!object(raw)) throw new Error('Invalid SQL result');
  if (kind === 'save') {
    if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 0) throw new Error('Invalid draft response');
    return { version: raw.version };
  }
  if (kind === 'submit' || kind === 'status') {
    if (raw.state !== 'submitted' || typeof raw.attemptId !== 'string' || !UUID.test(raw.attemptId)) throw new Error('Invalid receipt');
    return { state: 'submitted', attemptId: raw.attemptId };
  }
  if (kind !== 'inspect' && kind !== 'start') throw new Error('Unexpected SQL projection');
  if (raw.state === 'submitted') {
    if (typeof raw.attemptId !== 'string' || !UUID.test(raw.attemptId)) throw new Error('Invalid receipt');
    return { state: 'submitted', attemptId: raw.attemptId };
  }
  if (raw.state === 'not_started' && kind === 'inspect') {
    if (typeof raw.revisionId !== 'string' || !UUID.test(raw.revisionId) ||
        !Number.isInteger(raw.version) || typeof raw.label !== 'string' ||
        !Number.isInteger(raw.durationMinutes) || (raw.durationMinutes as number) > 180)
      throw new Error('Invalid prestart view');
    return { state: 'not_started', revisionId: raw.revisionId, version: raw.version,
      durationMinutes: raw.durationMinutes, label: 'Test kompetencji' };
  }
  if (raw.state !== 'in_progress' || typeof raw.attemptId !== 'string' || !UUID.test(raw.attemptId) ||
      typeof raw.startedAt !== 'string' || typeof raw.deadlineAt !== 'string' ||
      !object(raw.test) || !object(raw.draft)) throw new Error('Invalid active attempt view');
  const t = raw.test; const d = raw.draft;
  if (typeof t.revisionId !== 'string' || !UUID.test(t.revisionId) ||
      !Number.isInteger(t.version) || typeof t.title !== 'string' ||
      typeof t.instructions !== 'string' || typeof t.expectedOutput !== 'string' ||
      !Number.isInteger(t.durationMinutes) || (t.durationMinutes as number) > 180 ||
      typeof d.text !== 'string' || !Number.isSafeInteger(d.version) ||
      (d.version as number) < 0) throw new Error('Invalid attempt fields');
  return { state: 'in_progress', attemptId: raw.attemptId, startedAt: raw.startedAt, deadlineAt: raw.deadlineAt,
    test: { revisionId: t.revisionId, version: t.version, title: t.title, instructions: t.instructions,
      expectedOutput: t.expectedOutput, durationMinutes: t.durationMinutes },
    draft: { text: d.text, version: d.version } };
}
function statusFor(error: unknown): number {
  if (!object(error)) return 503;
  if (error.code === 'PT404') return 404;
  if (error.code === 'PT409') return 409;
  if (error.code === 'PT422') return 422;
  return 503;
}

export function createCompetencyBroker(deps: CompetencyBrokerDependencies): (request: Request) => Promise<Response> {
  let inFlight = 0;
  const now = deps.now || Date.now;
  const maxInFlight = deps.maxInFlight ?? 8;
  return async (request: Request) => {
    if (!deps.enabled) return response(503, { error: 'unavailable' });
    if (request.method !== 'POST') return competencyBrokerMethodDenied();
    if (!sameOrigin(request, deps.expectedOrigin)) return response(403, { error: 'unavailable' });
    if (!allowedHeaders(request)) return response(413, { error: 'invalid_request' });
    let input: Parsed | null;
    try { input = parse(await boundedJson(request)); }
    catch (error) { return response(error instanceof RangeError ? 413 : 400, { error: 'invalid_request' }); }
    if (!input) return response(400, { error: 'invalid_request' });
    const source = deps.trustedSource(request);
    if (!source || !isIP(source)) return response(503, { error: 'unavailable' });
    const minute = Math.floor(now() / (LIMIT_WINDOW_SECONDS * 1000));
    const hour = Math.floor(now() / 3600000);
    const sourceHmac = hmac(deps.sourceKey, 'b3-source-hour-' + String(hour), source);
    try {
      if (!await deps.limiter.consume(sourceHmac, minute)) return response(429, { error: 'rate_limited' });
    } catch {
      // Any limiter failure is an infrastructure failure; never use local memory.
      return response(503, { error: 'unavailable' });
    }
    let cookie: string | null;
    let init: string | null;
    try {
      cookie = exactCookie(request.headers.get('cookie'), B3_SESSION_COOKIE);
      init = exactCookie(request.headers.get('cookie'), B3_INIT_COOKIE);
    } catch {
      return response(403, { error: 'unavailable' });
    }
    if (input.operation === 'bootstrap') {
      if (request.headers.get('x-sc014-intent') !== 'bootstrap') return response(403, { error: 'unavailable' });
      if (cookie) return response(200, { csrf: hmac(deps.csrfKey, 'session', cookie) });
      const nonce = randomBytes(32).toString('hex');
      return response(200, { csrf: hmac(deps.csrfKey, 'preflight:' + deps.expectedOrigin, nonce) },
        [cookieHeader(B3_INIT_COOKIE, nonce, 300)]);
    }
    const supplied = request.headers.get('x-sc014-csrf');
    if (input.operation === 'exchange') {
      if (cookie || !init || !equalSecret(supplied, hmac(deps.csrfKey, 'preflight:' + deps.expectedOrigin, init))) {
        return response(403, { error: 'unavailable' });
      }
    } else if (!cookie || !equalSecret(supplied, hmac(deps.csrfKey, 'session', cookie))) {
      return response(403, { error: 'unavailable' });
    }
    if (inFlight >= maxInFlight) return response(503, { error: 'unavailable' });
    inFlight += 1;
    let lease: GatewayLease | null = null;
    let clean = false;
    try {
      lease = await deps.acquire();
      const operation: CompetencyOperation = input.operation === 'exchange'
        ? { kind: 'exchange', token: input.token }
        : input.operation === 'inspect' || input.operation === 'status'
          ? { kind: input.operation, session: cookie! }
          : input.operation === 'start'
            ? { kind: 'start', session: cookie!, requestKey: input.requestKey }
            : input.operation === 'save'
              ? { kind: 'save', session: cookie!, draft: input.draft,
                expectedVersion: input.expectedVersion, requestKey: input.requestKey }
              : { kind: 'submit', session: cookie!, answer: input.answer, requestKey: input.requestKey };
      const sqlResult: unknown = await executeCompetencyOperation(lease, operation);
      // The transport returns only after COMMIT. Never send partial success.
      if (input.operation === 'exchange') {
        if (!object(sqlResult) || typeof sqlResult.session !== 'string' ||
            !CAPABILITY.test(sqlResult.session) || typeof sqlResult.expiresAt !== 'string') {
          throw new Error('Invalid committed exchange');
        }
        const expiresAt = Date.parse(sqlResult.expiresAt);
        const maxAge = Math.ceil((expiresAt - now()) / 1000) + COOKIE_LIFETIME_AFTER_START_BY_SECONDS;
        if (!Number.isFinite(maxAge) || maxAge < 1 || maxAge > MAX_COOKIE_AGE_SECONDS)
          throw new Error('Invalid committed session lifetime');
        const issued = sqlResult.session;
        clean = true;
        return response(200, { state: 'session_established', csrf: hmac(deps.csrfKey, 'session', issued) },
          [cookieHeader(B3_SESSION_COOKIE, issued, maxAge), cookieHeader(B3_INIT_COOKIE, '', 0)]);
      }
      const safe = project(input.operation, sqlResult);
      clean = true;
      return response(200, safe);
    } catch (error) {
      // No raw SQL, body, cookie, secret, candidate response, or provider error
      // in logs/trace. All unknown failures map to a generic response.
      return response(statusFor(error), { error: 'unavailable' });
    } finally {
      if (lease) {
        // A failing COMMIT, failed ROLLBACK, timeout, or driver error may leave
        // transaction state unknown. Destroy any lease that did not fully succeed.
        try { lease.release(!clean); } catch { /* never log provider context */ }
      }
      inFlight -= 1;
    }
  };
}
