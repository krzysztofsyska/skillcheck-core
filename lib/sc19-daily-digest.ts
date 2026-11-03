/** SC-DIGEST-001: one internal e-mail a day, at 19:00 Europe/Warsaw, summarising
 * new companies. Owner decision 2026-11-03.
 *
 * NOTHING IS SENT TO COMPANIES. The only recipient is the internal address in
 * SC19_DIGEST_RECIPIENT; no address is ever taken from the database, the request
 * or the summary, and the summary carries counts only — no company name, NIP,
 * e-mail or candidate data.
 *
 * DAYLIGHT SAVING TIME. Vercel cron expressions are UTC and cannot follow Polish
 * local time, so 19:00 in Warsaw is 18:00 UTC in winter (CET, UTC+1) and 17:00
 * UTC in summer (CEST, UTC+2). The cron in vercel.json therefore fires at BOTH
 * 17:00 and 18:00 UTC every day, and `isDigestHour` lets exactly one of the two
 * runs through: the one where the Europe/Warsaw wall clock reads 19. The other
 * returns `skipped` without reading anything or sending anything. The mail keeps
 * arriving at 19:00 local on both sides of the March and October changeovers
 * with no code, cron or environment change; on the two changeover days it is
 * still one mail, because only one of the two runs sees hour 19.
 */

export const DIGEST_LOCAL_HOUR = 19;
export const DIGEST_TIME_ZONE = 'Europe/Warsaw';

/** Wall-clock hour in Warsaw, read through Intl so the DST rules come from the
 * platform's tz database rather than from arithmetic we would have to maintain. */
export function warsawHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: DIGEST_TIME_ZONE, hour: '2-digit', hour12: false }).format(now);
  return Number(hour);
}

/** The Warsaw calendar day the summary covers: the day that is ending. */
export function warsawDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DIGEST_TIME_ZONE }).format(now);
}

export function isDigestHour(now: Date): boolean {
  return warsawHour(now) === DIGEST_LOCAL_HOUR;
}

export type DigestCounts = Readonly<{
  registered: number;
  auto_free: number;
  awaiting_manual: number;
  marketing_consents: number;
}>;

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

export function parseDigestCounts(row: unknown): DigestCounts {
  const source = (row && typeof row === 'object' && !Array.isArray(row) ? row : {}) as Record<string, unknown>;
  return Object.freeze({
    registered: count(source.registered),
    auto_free: count(source.auto_free),
    awaiting_manual: count(source.awaiting_manual),
    marketing_consents: count(source.marketing_consents),
  });
}

/** Plain Polish, counts only. Deliberately contains no identifying data, so the
 * mail can sit in an ordinary inbox. */
export function digestMessage(day: string, counts: DigestCounts) {
  const lines = [
    `Podsumowanie SkillCheck za ${day} (stan na 19:00).`,
    '',
    `Nowe firmy: ${counts.registered}`,
    `FREE przyznany automatycznie: ${counts.auto_free}`,
    `Czeka na ręczne sprawdzenie: ${counts.awaiting_manual}`,
    `Zgoda na kontakt handlowy: ${counts.marketing_consents}`,
    '',
    'Szczegóły: /operator/billing',
  ];
  return { subject: `SkillCheck — nowe firmy ${day}`, text: lines.join('\n') };
}

const ADDRESS = /^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/;

/** One internal address, from the environment. Never hardcoded, never from the
 * database, never a list: a single malformed or injected value disables the mail
 * instead of sending somewhere unintended. */
export function digestRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.SC19_DIGEST_RECIPIENT ?? '').trim();
  if (!value || value.length > 254 || /[\x00-\x1f\x7f]/.test(value) || !ADDRESS.test(value)) return null;
  return value;
}

export function digestSender(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.SC19_DIGEST_SENDER ?? '').trim();
  if (!value || value.length > 254 || /[\x00-\x1f\x7f]/.test(value) || !/^[^\s<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/.test(value)) return null;
  return value;
}

/** Every switch must be on: the feature flag, a configured provider key, a valid
 * internal recipient and sender. Anything missing means the run reports
 * `disabled` and sends nothing. No new paid service is introduced — this reuses
 * the Resend key already configured for the project. */
export function digestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SC19_DIGEST_ENABLED === 'true' && Boolean(env.RESEND_API_KEY)
    && digestRecipient(env) !== null && digestSender(env) !== null;
}

export type DigestOutcome = 'sent' | 'retry' | 'failed';

export async function sendDigest(input: { day: string; counts: DigestCounts; apiKey: string; to: string; from: string },
  fetcher: typeof fetch = fetch): Promise<DigestOutcome> {
  const { subject, text } = digestMessage(input.day, input.counts);
  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        // One mail per Warsaw day even if the endpoint is called twice.
        'Idempotency-Key': `sc19-daily-digest-v1/${input.day}`,
      },
      body: JSON.stringify({ from: input.from, to: [input.to], subject, text }),
    });
    if (response.ok) return 'sent';
    return response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500 ? 'retry' : 'failed';
  } catch {
    return 'retry';
  }
}
