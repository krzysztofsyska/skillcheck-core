import { authorizedMailWorker } from '../../../../lib/sales-mail';
import { runDailyDigest } from '../../../../lib/sc19-daily-digest-server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** SC-DIGEST-001: scheduler endpoint for the one internal daily summary.
 *
 * TIME. The cron in vercel.json fires at 17:00 AND 18:00 UTC every day, because
 * Vercel cron is UTC-only and 19:00 in Poland is 18:00 UTC in winter (CET) and
 * 17:00 UTC in summer (CEST). runDailyDigest lets through only the run whose
 * Europe/Warsaw wall clock reads 19, so exactly one mail is sent per day and
 * nothing changes at the March and October changeovers. The other run returns
 * `skipped` without reading or sending anything.
 *
 * AUTHORIZATION. A bearer secret, same construction as the sales mail worker.
 * Vercel sends it as the Authorization header of the cron request. Without it
 * the endpoint answers 401 and does nothing. */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorizedMailWorker(request.headers.get('authorization'), process.env.SC19_DIGEST_CRON_SECRET)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  }
  try {
    const status = await runDailyDigest();
    // Never log the recipient, the counts or any provider response.
    return Response.json({ status }, { status: status === 'failed' ? 503 : 200, headers });
  } catch {
    console.error('sc19_daily_digest_failed');
    return Response.json({ error: 'digest_failed' }, { status: 503, headers });
  }
}
