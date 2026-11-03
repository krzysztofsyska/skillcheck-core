import 'server-only';
import { randomUUID } from 'node:crypto';
import { createClient } from './supabase/server';
import { signTrialAuto, trialAutoEnabled } from './sc19-trial-auto.ts';
import {
  digestEnabled, digestRecipient, digestSender, isDigestHour, parseDigestCounts,
  sendDigest, warsawDay, type DigestOutcome,
} from './sc19-daily-digest.ts';

export type DigestRunStatus = 'skipped' | 'disabled' | 'unconfigured' | 'failed' | DigestOutcome;

/** Formats a timestamp the way public.sc19_daily_digest signs it: UTC, seconds. */
function utcStamp(value: Date) {
  return value.toISOString().replace(/\.\d+Z$/, '').replace(/Z$/, '');
}

/** SC-DIGEST-001: one internal summary a day. The window is the Warsaw calendar
 * day that is ending, expressed in UTC so the database and the signature agree.
 *
 * Reads counts only and mails them to the one address in SC19_DIGEST_RECIPIENT.
 * Nothing is ever sent to a company: no company address is read, and the
 * summary itself carries no name, NIP or e-mail. */
export async function runDailyDigest(now: Date = new Date()): Promise<DigestRunStatus> {
  // The cron fires at 17:00 and 18:00 UTC; exactly one of them is 19:00 in Warsaw.
  if (!isDigestHour(now)) return 'skipped';
  if (!digestEnabled()) return 'disabled';
  if (!trialAutoEnabled()) return 'unconfigured';
  const to = digestRecipient(), from = digestSender();
  if (!to || !from) return 'unconfigured';

  const day = warsawDay(now);
  // 19:00 local today back to 19:00 local yesterday: a full 24 h, and on the two
  // DST changeover days it is 23 h or 25 h, which is what "since yesterday
  // evening" means to a reader.
  const windowEnd = new Date(now);
  windowEnd.setUTCSeconds(0, 0);
  windowEnd.setUTCMinutes(0);
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  const client = await createClient();
  const requestId = randomUUID(), issuedAtMs = Date.now();
  const payload = [utcStamp(windowStart), utcStamp(windowEnd)].join('\n');
  const { data, error } = await client.rpc('sc19_daily_digest', {
    window_start: windowStart.toISOString(), window_end: windowEnd.toISOString(),
    request_id: requestId, issued_at_ms: issuedAtMs,
    request_signature: signTrialAuto('digest', requestId, issuedAtMs, payload, process.env.SC19_TRIAL_AUTO_SECRET!),
  });
  if (error || !data) return 'failed';
  const counts = parseDigestCounts(Array.isArray(data) ? data[0] : data);
  return sendDigest({ day, counts, apiKey: process.env.RESEND_API_KEY!, to, from });
}
