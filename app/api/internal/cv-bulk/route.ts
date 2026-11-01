import { authorizedMailWorker } from '../../../../lib/sales-mail';
import { bulkWorkerConfigured, pumpScheduled } from '../../../../lib/cv-bulk-server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Background pump for bulk CV batches whose browser tab was closed.
 * Prepared for a scheduler (e.g. Vercel Cron every minute); no cron is
 * registered until the owner approves it for production.
 */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorizedMailWorker(request.headers.get('authorization'), process.env.CV_BULK_CRON_SECRET)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  }
  if (!bulkWorkerConfigured()) return Response.json({ status: 'disabled' }, { status: 503, headers });
  try {
    return Response.json({ batches: await pumpScheduled() }, { headers });
  } catch {
    console.error('cv_bulk_worker_failed');
    return Response.json({ error: 'worker_failed' }, { status: 503, headers });
  }
}
