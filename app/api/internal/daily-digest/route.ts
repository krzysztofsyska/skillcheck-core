import { authorizedMailWorker } from '../../../../lib/sales-mail';
import { runDailyDigest } from '../../../../lib/sc19-daily-digest-server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** SC-DIGEST-001: scheduler endpoint for the one internal daily summary.
 *
 * WHO CALLS IT. .github/workflows/sc19-daily-digest.yml, exactly as
 * .github/workflows/cv-bulk-pump.yml already calls /api/internal/cv-bulk.
 * NOT Vercel Cron: Vercel puts the value of the environment variable named
 * `CRON_SECRET` — that name and no other — into the Authorization header of a
 * cron request, so a deployment that provisions only SC19_DIGEST_CRON_SECRET
 * would answer 401 on every scheduled call and no digest would ever run. Two
 * schedules a day for one path also needs a plan this project does not have
 * (Hobby allows one daily invocation per cron job and fires it inside a
 * one-hour window), and a paid plan is a new cost, which is the owner's
 * decision. GitHub Actions costs nothing and is the pattern already in the
 * repository, so `crons` is not in vercel.json.
 *
 * TIME. The workflow fires at 17:00, 17:30, 18:00, 18:30, 19:00 and 19:30 UTC,
 * because 19:00 in Poland is 18:00 UTC in winter (CET) and 17:00 UTC in summer
 * (CEST), and a GitHub schedule is best effort and can be late. runDailyDigest
 * lets through only a run whose Europe/Warsaw wall clock reads 19, so the extra
 * firings return `skipped` without reading or sending anything, and at least one
 * firing lands inside that hour on both sides of the March and October
 * changeovers even when the scheduler is up to half an hour late. If two do, the
 * Resend idempotency key (one per Warsaw day) still means one mail.
 *
 * AUTHORIZATION. A bearer secret, same construction as the sales mail worker and
 * the bulk CV pump. Without it the endpoint answers 401 and does nothing.
 *
 * RETRY. A retryable provider answer reports 503, not 200: the caller then fails
 * loudly, and the next firing in the same Warsaw hour tries again under the same
 * idempotency key. Nothing is queued here; the summary is a convenience and a
 * lost one is not worth a durable outbox. */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorizedMailWorker(request.headers.get('authorization'), process.env.SC19_DIGEST_CRON_SECRET)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  }
  try {
    const status = await runDailyDigest();
    // Never log the recipient, the counts or any provider response.
    const failed = status === 'failed' || status === 'retry';
    return Response.json({ status }, { status: failed ? 503 : 200, headers });
  } catch {
    console.error('sc19_daily_digest_failed');
    return Response.json({ error: 'digest_failed' }, { status: 503, headers });
  }
}
