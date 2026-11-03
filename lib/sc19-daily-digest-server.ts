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
  // Exactly 24 h back from the top of the current UTC hour. On the two DST
  // changeover days that is NOT "since 19:00 local yesterday": in March the
  // window starts at 18:00 local, so the hour 18:00–19:00 of the previous day is
  // counted a second time (it was already in that day's summary), and in October
  // it starts at 20:00 local, so the hour 19:00–20:00 is counted in neither
  // summary. One hour a year is double-counted and one hour a year is missed, in
  // counts of new companies. That is accepted for an internal summary rather
  // than carrying a stored high-water mark; the figures it is compared against
  // (/operator/billing) are not derived from this window.
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
