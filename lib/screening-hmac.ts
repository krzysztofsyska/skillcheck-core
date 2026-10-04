import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SCREENING_DISPATCH_MAX_SKEW_SECONDS = 60;
export const SCREENING_DISPATCH_SECRET_MIN_BYTES = 32;
export const SCREENING_DISPATCH_TIMESTAMP_HEADER = 'x-skillcheck-timestamp';
export const SCREENING_DISPATCH_SIGNATURE_HEADER = 'x-skillcheck-signature';

export type ScreeningDispatchFailure = 'missing' | 'secret' | 'timestamp' | 'signature' | 'body';

function asBuffer(body: Uint8Array | Buffer) {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

export function assertScreeningDispatchSecret(secret: string) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < SCREENING_DISPATCH_SECRET_MIN_BYTES) {
    throw new Error('Dispatch secret is too short.');
  }
}

export function hashScreeningBody(body: Uint8Array | Buffer) {
  return createHash('sha256').update(asBuffer(body)).digest('hex');
}

export function signScreeningDispatch(secret: string, timestamp: string, body: Uint8Array | Buffer) {
  assertScreeningDispatchSecret(secret);
  if (!/^\d+$/.test(timestamp)) throw new Error('Invalid dispatch timestamp.');
  return createHmac('sha256', secret).update(`${timestamp}.${hashScreeningBody(body)}`).digest('hex');
}

function equalHex(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function verifyScreeningDispatch(input: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: Uint8Array | Buffer;
  nowMs?: number;
}): { ok: true } | { ok: false; code: ScreeningDispatchFailure } {
  if (!input.timestamp || !input.signature) return { ok: false, code: 'missing' };
  try {
    assertScreeningDispatchSecret(input.secret);
  } catch {
    return { ok: false, code: 'secret' };
  }
  if (!/^\d+$/.test(input.timestamp)) return { ok: false, code: 'timestamp' };
  const timestampMs = Number(input.timestamp) * 1000;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > SCREENING_DISPATCH_MAX_SKEW_SECONDS * 1000) {
    return { ok: false, code: 'timestamp' };
  }
  const expected = signScreeningDispatch(input.secret, input.timestamp, input.body);
  if (!equalHex(expected, input.signature.trim().toLowerCase())) return { ok: false, code: 'signature' };
  return { ok: true };
}

export function screeningDispatchBody(attemptId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    throw new Error('Nieprawidłowy identyfikator próby.');
  }
  return Buffer.from(JSON.stringify({ attempt_id: attemptId }), 'utf8');
}

export function parseScreeningDispatchAttempt(body: Uint8Array | Buffer) {
  const raw = asBuffer(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Nieprawidłowe żądanie workera.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Nieprawidłowe żądanie workera.');
  const attemptId = (parsed as { attempt_id?: unknown }).attempt_id;
  if (typeof attemptId !== 'string') throw new Error('Nieprawidłowe żądanie workera.');
  screeningDispatchBody(attemptId);
  return attemptId;
}
