import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  digestEnabled, digestMessage, digestRecipient, digestSender, isDigestHour,
  parseDigestCounts, sendDigest, warsawDay, warsawHour,
} from '../lib/sc19-daily-digest.ts';

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const counts = { registered: 3, auto_free: 2, awaiting_manual: 1, marketing_consents: 2 };
const ready = extra => ({
  SC19_DIGEST_ENABLED: 'true', RESEND_API_KEY: 'key',
  SC19_DIGEST_RECIPIENT: 'operator@skillcheck.pl', SC19_DIGEST_SENDER: 'bot@skillcheck.pl', ...extra,
});

test('the cron fires twice in UTC and exactly one run is 19:00 in Warsaw', () => {
  // Vercel cron is UTC only. 19:00 Warsaw is 18:00 UTC in winter (CET) and
  // 17:00 UTC in summer (CEST), so both hours are scheduled and the handler
  // picks the right one.
  assert.deepEqual(vercel.crons, [{ path: '/api/internal/daily-digest', schedule: '0 17,18 * * *' }]);
  const scheduled = ['17', '18'];

  const check = (date, expectedHour) => {
    const hits = scheduled.filter(hour => isDigestHour(new Date(`${date}T${hour}:00:00Z`)));
    assert.deepEqual(hits, [expectedHour], `${date}: exactly one run at 19:00 local`);
  };
  check('2026-01-15', '18'); // deep winter, CET
  check('2026-07-15', '17'); // high summer, CEST
  // The changeover days themselves: still one mail, not zero and not two.
  check('2026-03-29', '17'); // CET -> CEST
  check('2026-10-25', '18'); // CEST -> CET
  // The days either side of each changeover.
  check('2026-03-28', '18');
  check('2026-03-30', '17');
  check('2026-10-24', '17');
  check('2026-10-26', '18');

  // Every other hour of the day is skipped.
  for (const hour of ['00', '05', '12', '16', '19', '20', '23']) {
    assert.equal(isDigestHour(new Date(`2026-01-15T${hour}:00:00Z`)), hour === '18', hour);
  }
  assert.equal(warsawHour(new Date('2026-01-15T18:00:00Z')), 19);
  assert.equal(warsawHour(new Date('2026-07-15T17:00:00Z')), 19);
  assert.equal(warsawDay(new Date('2026-01-15T18:00:00Z')), '2026-01-15');
  // Just before midnight local, the day is still the one that is ending.
  assert.equal(warsawDay(new Date('2026-01-15T22:59:00Z')), '2026-01-15');
});

test('the recipient comes from the environment and is never hardcoded', () => {
  assert.equal(digestRecipient({ SC19_DIGEST_RECIPIENT: 'operator@skillcheck.pl' }), 'operator@skillcheck.pl');
  for (const value of [undefined, '', '   ', 'not-an-address', 'a@b', 'a@b@c.pl', 'x'.repeat(260) + '@b.pl',
    'operator@skillcheck.pl\nbcc: ktos@example.com', 'operator@skillcheck.pl, inny@example.com']) {
    assert.equal(digestRecipient({ SC19_DIGEST_RECIPIENT: value }), null, JSON.stringify(value));
  }
  assert.equal(digestSender({ SC19_DIGEST_SENDER: undefined }), null);
  // No address literal anywhere in the digest code.
  for (const file of ['../lib/sc19-daily-digest.ts', '../lib/sc19-daily-digest-server.ts', '../app/api/internal/daily-digest/route.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /[\w.-]+@[\w-]+\.(pl|com|net|eu)/i, `${file} contains no e-mail address`);
  }
});

test('every switch must be on, and a missing one disables the mail', () => {
  assert.equal(digestEnabled(ready()), true);
  assert.equal(digestEnabled(ready({ SC19_DIGEST_ENABLED: 'false' })), false);
  assert.equal(digestEnabled(ready({ SC19_DIGEST_ENABLED: undefined })), false);
  assert.equal(digestEnabled(ready({ RESEND_API_KEY: undefined })), false);
  assert.equal(digestEnabled(ready({ SC19_DIGEST_RECIPIENT: 'broken' })), false);
  assert.equal(digestEnabled(ready({ SC19_DIGEST_SENDER: undefined })), false);
});

test('the summary carries the four counts and nothing that identifies anyone', () => {
  const { subject, text } = digestMessage('2026-11-03', counts);
  assert.equal(subject, 'SkillCheck — nowe firmy 2026-11-03');
  for (const line of ['Nowe firmy: 3', 'FREE przyznany automatycznie: 2',
    'Czeka na ręczne sprawdzenie: 1', 'Zgoda na kontakt handlowy: 2']) {
    assert.ok(text.includes(line), line);
  }
  // Counts only: nothing that could be a name, NIP or address.
  assert.doesNotMatch(text, /@/, 'no e-mail address in the body');
  assert.doesNotMatch(text, /\b\d{10}\b/, 'no NIP in the body');
});

test('counts from the database are coerced, never trusted blindly', () => {
  assert.deepEqual({ ...parseDigestCounts(counts) }, counts);
  assert.deepEqual({ ...parseDigestCounts(null) }, { registered: 0, auto_free: 0, awaiting_manual: 0, marketing_consents: 0 });
  assert.deepEqual({ ...parseDigestCounts({ registered: -5, auto_free: '3', awaiting_manual: 1.7, marketing_consents: NaN }) },
    { registered: 0, auto_free: 0, awaiting_manual: 1, marketing_consents: 0 });
});

test('the mail goes to the one internal address, once per day', async () => {
  const sent = [];
  const fetcher = async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200 }; };
  const outcome = await sendDigest({ day: '2026-11-03', counts, apiKey: 'key', to: 'operator@skillcheck.pl', from: 'bot@skillcheck.pl' }, fetcher);
  assert.equal(outcome, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.to, ['operator@skillcheck.pl'], 'exactly one recipient, the internal one');
  // Same key for the same Warsaw day: a second call cannot produce a second mail.
  assert.equal(sent[0].init.headers['Idempotency-Key'], 'sc19-daily-digest-v1/2026-11-03');
});

test('a provider failure is reported, not retried blindly', async () => {
  const outcomes = { 429: 'retry', 500: 'retry', 503: 'retry', 408: 'retry', 400: 'failed', 403: 'failed' };
  for (const [status, expected] of Object.entries(outcomes)) {
    const result = await sendDigest({ day: '2026-11-03', counts, apiKey: 'k', to: 'a@b.pl', from: 'c@d.pl' },
      async () => ({ ok: false, status: Number(status) }));
    assert.equal(result, expected, status);
  }
  assert.equal(await sendDigest({ day: '2026-11-03', counts, apiKey: 'k', to: 'a@b.pl', from: 'c@d.pl' },
    async () => { throw new Error('network'); }), 'retry');
});

test('the digest never reads or mails a company address', () => {
  const server = readFileSync(new URL('../lib/sc19-daily-digest-server.ts', import.meta.url), 'utf8');
  // The only database call is the counts RPC.
  const rpcs = server.match(/client\.rpc\('([a-z0-9_]+)'/g) ?? [];
  assert.deepEqual(rpcs, ["client.rpc('sc19_daily_digest'"], 'one RPC, counts only');
  assert.doesNotMatch(server, /\.from\(/, 'no table reads');
  // And the SQL behind it returns four integers, nothing else.
  const migration = readFileSync(new URL('../supabase/migrations/20261103090000_sc19_auto_trial_marketing_consent.sql', import.meta.url), 'utf8');
  assert.match(migration, /create function public\.sc19_daily_digest[\s\S]*?returns table\(registered integer, auto_free integer, awaiting_manual integer, marketing_consents integer\)/);
});
