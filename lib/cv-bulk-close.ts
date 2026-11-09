/**
 * Closing an uploaded bulk batch, as seen by the uploader UI.
 *
 * Only an explicit success from the server action counts as "closed". An `{error}` response, a missing
 * response or a rejected promise all mean "not confirmed". The guard ignores a second call while one is
 * in flight, and the same closer is reused for retries, so a retry only repeats the close of the same batch.
 */
export type CloseResult = { error?: string } | null | undefined | void;

export function createBatchCloser(close: () => Promise<CloseResult>) {
  let inFlight = false;
  return async function closeOnce(): Promise<'closed' | 'unconfirmed' | 'busy'> {
    if (inFlight) return 'busy';
    inFlight = true;
    try {
      const result = await close();
      return result && result.error ? 'unconfirmed' : 'closed';
    } catch {
      return 'unconfirmed';
    } finally {
      inFlight = false;
    }
  };
}
