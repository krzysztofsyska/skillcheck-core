/**
 * SC-014-B3. Shared, atomic, bounded rate limits. Every deployed instance must
 * use the SAME Redis REST database. No local/in-memory production fallback.
 * Redis data: anonymous hourly-HMAC source fields, total counter, <= 75s TTL.
 * Not candidate records; no token/digest/attempt or candidate identifiers.
 */
export const LIMIT_WINDOW_SECONDS = 60;
export const MAX_SOURCES_PER_WINDOW = 4096;
export const DEFAULT_GLOBAL_LIMIT = 300;
export const DEFAULT_SOURCE_LIMIT = 15;

// KEYS[1]: global integer; KEYS[2]: hash of anonymized sources.
// ARGV: HMAC source, global budget, source budget, cardinality cap, TTL.
// A single EVAL makes both decisions and mutations atomic across instances.
export const B3_REDIS_LIMIT_SCRIPT = [
  "local g=tonumber(redis.call('GET',KEYS[1]) or '0')",
  "local s=tonumber(redis.call('HGET',KEYS[2],ARGV[1]) or '0')",
  "if g>=tonumber(ARGV[2]) or s>=tonumber(ARGV[3]) then return 0 end",
  "if s==0 and redis.call('HLEN',KEYS[2])>=tonumber(ARGV[4]) then return 0 end",
  "if g==0 then redis.call('SET',KEYS[1],0,'EX',ARGV[5]) end",
  "redis.call('INCR',KEYS[1])",
  "redis.call('HINCRBY',KEYS[2],ARGV[1],1)",
  "if redis.call('TTL',KEYS[2])<0 then redis.call('EXPIRE',KEYS[2],ARGV[5]) end",
  "return 1"
].join("\n");

export interface SharedRateLimiter {
  consume(sourceHmac: string, windowId: number): Promise<boolean>;
}

export function createRedisRestLimiter(
  endpoint: string,
  bearerToken: string,
  request: typeof fetch = fetch,
  limits = { global: DEFAULT_GLOBAL_LIMIT, source: DEFAULT_SOURCE_LIMIT }
): SharedRateLimiter {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !bearerToken || /\s/.test(bearerToken) ||
      !Number.isSafeInteger(limits.global) || limits.global < 1 ||
      !Number.isSafeInteger(limits.source) || limits.source < 1 ||
      limits.source > limits.global) throw new Error('Invalid shared limiter configuration');
  return {
    async consume(sourceHmac, windowId) {
      if (!/^[a-f0-9]{64}$/.test(sourceHmac) ||
          !Number.isSafeInteger(windowId) || windowId < 0) throw new Error('Invalid rate limit context');
      const key = 'sc014:b3:' + String(windowId);
      // Upstash REST supports a command as a JSON array; EVAL is atomic.
      const response = await request(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + bearerToken,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store'
        },
        body: JSON.stringify(['EVAL', B3_REDIS_LIMIT_SCRIPT, 2, key + ':total', key + ':sources',
          sourceHmac, limits.global, limits.source, MAX_SOURCES_PER_WINDOW, LIMIT_WINDOW_SECONDS + 15]),
        signal: AbortSignal.timeout(1500),
        cache: 'no-store',
        redirect: 'error'
      });
      if (!response.ok) throw new Error('Shared limiter unavailable');
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('result' in payload)) {
        throw new Error('Invalid shared limiter response');
      }
      const result = (payload as {result: unknown}).result;
      if (result !== 0 && result !== 1) throw new Error('Invalid shared limiter response');
      return result === 1;
    }
  };
}
