export function retryDelayMs(attemptNumber, retryAfterHeader, rng = Math.random) {
  const scheduled = attemptNumber === 1 ? 60_000 : attemptNumber === 2 ? 300_000 : null;
  const retryAfter = retryAfterHeader == null || retryAfterHeader === ''
    ? null
    : Number(retryAfterHeader) * 1000;
  if (scheduled == null && (retryAfter == null || Number.isNaN(retryAfter))) return null;
  const jitter = Math.floor(rng() * 1000);
  return Math.max(scheduled ?? 0, Number.isNaN(retryAfter) ? 0 : retryAfter) + (scheduled == null ? 0 : jitter);
}

export async function withTransportRetry(operation, { sleep = delay => new Promise(resolve => setTimeout(resolve, delay)), rng = Math.random, maxAttempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const status = error.status ?? error.statusCode ?? null;
      if (status === 401 || status === 403 || error.code === 'BLOCKED_CONFIGURATION') {
        const blocked = new Error('BLOCKED_CONFIGURATION');
        blocked.code = 'BLOCKED_CONFIGURATION';
        blocked.status = status;
        throw blocked;
      }
      if (status === 409) throw error;
      const retryable = status === 429 || (status >= 500 && status <= 599) || error.timeout === true;
      if (!retryable || attempt === maxAttempts - 1) throw error;
      const wait = retryDelayMs(attempt + 1, error.retryAfter ?? null, rng);
      if (wait == null) throw error;
      await sleep(wait);
    }
  }
  throw lastError;
}
