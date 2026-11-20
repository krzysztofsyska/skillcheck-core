// Shared deployment-gate helpers of the payment adapter (R7: Stripe only).
//
// The Przelewy24 sandbox gate that used to live here was removed (owner decision
// 19.11.2026, confirmed 20.11.2026: „wyrzucamy całkowicie P24”). What remains is
// used by lib/sc19-stripe-config.ts: the restricted database login check and the
// non-reversible shape hint used in refusals. The restricted roles keep their
// historical names (sc19_p24_preview / sc19_p24_checkout); they are database
// objects and are not renamed here.

/** Shape of a value that is public by construction (deployment identity, a
 * NEXT_PUBLIC_* address, an on/off flag): the value itself names the typo.
 * Anything long enough to be a key or a password is reported by length instead,
 * so a value pasted into the wrong variable is never echoed back. */
export const publicShape = (value: string | undefined, max = 64) =>
  value === undefined ? 'missing' : value === '' ? 'empty' :
    value.length > max || !/^[\x20-\x7E]*$/.test(value) ? `length:${value.length}` : `value:${value}`;

/** The adapter's own restricted login: a Supabase transaction-pooler URL whose user
 * is exactly <role>.<project ref> on port 6543. Nothing else is accepted, so the
 * variable cannot be pointed at another cluster, another database, another role,
 * or weakened with connection options (`?sslmode=disable`).
 *
 * On refusal it names the PARTS that disagree — protocol, username, password,
 * host, port, path, query — and never a part's value. */
export function restrictedDatabaseUrl(value: string | undefined, expectedRole: string, expectedRef: string) {
  if (!value) return { url: null, shape: value === '' ? 'empty' : 'missing' };
  let db: URL;
  try { db = new URL(value); } catch { return { url: null, shape: `not_a_url,length:${value.length}` }; }
  const wrong: string[] = [];
  if (db.protocol !== 'postgresql:') wrong.push('protocol');
  if (db.username !== expectedRole + '.' + expectedRef) wrong.push('username');
  if (!db.password) wrong.push('password');
  if (!/^aws-[0-9]+-eu-west-1\.pooler\.supabase\.com$/.test(db.hostname)) wrong.push('host');
  if (db.port !== '6543') wrong.push('port');
  if (db.pathname !== '/postgres') wrong.push('path');
  if (db.search || db.hash) wrong.push('query');
  return wrong.length ? { url: null, shape: 'wrong:' + wrong.join('+') } : { url: db.href, shape: 'ok' };
}
