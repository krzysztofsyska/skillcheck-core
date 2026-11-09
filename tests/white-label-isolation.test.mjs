// SC-020-D — czyste reguły: wspólna historia zmian marki i domen oraz zadanie
// cyklicznej weryfikacji DNS na atrapach (bez sieci i bazy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { whiteLabelAudit } from '../lib/white-label-audit.ts';
import { reverifyDueDomains, reverifyEnabled } from '../lib/tenant-domain-reverify.ts';

const A = '11111111-1111-4111-8111-111111111111';
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T1 = '1'.repeat(64), T2 = '2'.repeat(64);
const on = { VERCEL_ENV: 'preview', TENANT_DOMAIN_REVERIFY_ENABLED: 'true' };

test('combined white-label history: both logs, newest first, owner vs automatic, unknown actions kept', () => {
  const entries = whiteLabelAudit({
    viewerId: 'me',
    brandEvents: [
      { action: 'published', actor: 'me', at: '2026-11-09T10:00:00Z' },
      { action: 'rolled_back', actor: 'someone-else', at: '2026-11-09T12:00:00Z' },
      { action: 'future_action', actor: null, at: '2026-11-09T08:00:00Z' },
    ],
    domainEvents: [
      { domain_id: D1, action: 'activated', by_owner: true, at: '2026-11-09T11:00:00Z' },
      { domain_id: D2, action: 'verification_lapsed', by_owner: false, at: '2026-11-09T13:00:00Z' },
    ],
    hostnames: new Map([[D1, 'kariera.firma-a.pl']]),
  });
  assert.deepEqual(entries.map(e => [e.area, e.subject, e.action, e.who]), [
    ['domena', 'domena', 'weryfikacja wygasła — wymagana ponowna', 'automatycznie'],
    ['marka', 'wygląd panelu', 'przywrócono wcześniejszą wersję', 'inny użytkownik'],
    ['domena', 'kariera.firma-a.pl', 'włączono', 'właściciel'],
    ['marka', 'wygląd panelu', 'opublikowano wersję', 'Ty'],
    ['marka', 'wygląd panelu', 'future_action', 'system'],
  ]);
  assert.equal(whiteLabelAudit({ viewerId: 'me', brandEvents: [], domainEvents: [], hostnames: new Map() }).length, 0);
  const many = Array.from({ length: 300 }, (_, i) => ({ action: 'draft_saved', actor: 'me', at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  assert.equal(whiteLabelAudit({ viewerId: 'me', brandEvents: many, domainEvents: [], hostnames: new Map() }).length, 100);
});

test('scheduled re-verification: fail closed, outage writes nothing, renew/fail/lapse/skip counted, bad rows ignored', async () => {
  const writes = [];
  const store = rows => ({
    async due(limit) { assert.ok(limit >= 1 && limit <= 500); return rows; },
    async record(company, domain, token, ok) { writes.push([domain, ok]); return domain === D2 && !ok ? 'pending' : 'active'; },
  });
  const rows = [
    { company_id: A, domain_id: D1, hostname: 'kariera.firma-a.pl', verification_token: T1, last_verified_at: '2026-10-01T00:00:00.000000Z' },
    { company_id: A, domain_id: D2, hostname: 'praca.firma-a.pl', verification_token: T2, last_verified_at: '2026-10-02T00:00:00.000000Z' },
    { company_id: 'x', domain_id: D2, hostname: 'praca.firma-a.pl', verification_token: T2, last_verified_at: '2026-10-02T00:00:00.000000Z' },
    { company_id: A, domain_id: D2, hostname: 'localhost', verification_token: T2, last_verified_at: '2026-10-02T00:00:00.000000Z' },
  ];
  const txt = { [`_skillcheck-challenge.kariera.firma-a.pl`]: [[`skillcheck-domain-verification=${T1}`]] };
  const dns = { async resolveTxt(name) { if (name in txt) return txt[name]; throw Object.assign(new Error('no'), { code: 'ENOTFOUND' }); } };
  assert.deepEqual(await reverifyDueDomains({ store: null, dns, env: on }), { status: 'unconfigured' });
  for (const env of [{}, { VERCEL_ENV: 'preview' }, { ...on, VERCEL_ENV: 'production' }, { ...on, WHITE_LABEL_ENABLED: 'false' }]) {
    assert.equal(reverifyEnabled(env), false, JSON.stringify(env));
    assert.deepEqual(await reverifyDueDomains({ store: store(rows), dns, env }), { status: 'unconfigured' });
  }
  assert.equal(writes.length, 0);
  assert.equal(reverifyEnabled({ ...on, VERCEL_ENV: 'production', WHITE_LABEL_ENABLED: 'true' }), true);
  const result = await reverifyDueDomains({ store: store(rows), dns, env: on });
  assert.deepEqual(result, { status: 'done', checked: 2, renewed: 1, failed: 0, lapsed: 1, unavailable: 0, skipped: 0, errors: 2 });
  assert.deepEqual(writes, [[D1, true], [D2, false]]);
  writes.length = 0;
  const outage = { async resolveTxt() { throw Object.assign(new Error('t'), { code: 'ETIMEOUT' }); } };
  const down = await reverifyDueDomains({ store: store(rows.slice(0, 2)), dns: outage, env: on });
  assert.equal(down.unavailable, 2);
  assert.equal(writes.length, 0, 'a resolver outage never records a failure');
  const failing = { async due() { return rows.slice(0, 2); }, async record() { throw new Error('db'); } };
  assert.equal((await reverifyDueDomains({ store: failing, dns, env: on })).errors, 2, 'one failure does not stop the run');
  const skipping = { async due() { return rows.slice(0, 1); }, async record() { return 'skipped'; } };
  assert.equal((await reverifyDueDomains({ store: skipping, dns, env: on })).skipped, 1);
  // Pagination: domains whose DNS keeps failing do not starve the rest of the queue.
  const queue = Array.from({ length: 5 }, (_, i) => ({ company_id: A, domain_id: `cccccccc-cccc-4ccc-8ccc-00000000000${i}`,
    hostname: `d${i}.firma-a.pl`, verification_token: String(i).repeat(64), last_verified_at: `2026-10-0${i + 1}T00:00:00.000000Z` }));
  const pages = [];
  const paged = {
    async due(limit, after) {
      pages.push(after);
      const start = after ? queue.findIndex(row => row.domain_id === after.domain_id) + 1 : 0;
      return queue.slice(start, start + limit);
    },
    async record() { return 'active'; },
  };
  const flaky = { async resolveTxt(name) {
    if (/^_skillcheck-challenge\.d[01]\./.test(name)) throw Object.assign(new Error('t'), { code: 'ETIMEOUT' });
    const i = Number(name.match(/\.d(\d)\./)[1]);
    return [[`skillcheck-domain-verification=${String(i).repeat(64)}`]];
  } };
  const all = await reverifyDueDomains({ store: paged, dns: flaky, env: on }, { limit: 2 });
  assert.deepEqual([all.checked, all.unavailable, all.renewed], [5, 2, 3]);
  assert.deepEqual(pages.map(p => p?.domain_id ?? null), [null, queue[1].domain_id, queue[3].domain_id]);
  // The run's single connection is closed after the pass, after a failure and when unconfigured.
  let closed = 0;
  const closing = extra => ({ async due() { return rows.slice(0, 1); }, async record() { return 'active'; }, async close() { closed += 1; }, ...extra });
  await reverifyDueDomains({ store: closing(), dns, env: on });
  await assert.rejects(reverifyDueDomains({ store: closing({ async due() { throw new Error('db'); } }), dns, env: on }));
  await reverifyDueDomains({ store: closing(), dns, env: {} });
  assert.equal(closed, 3);
});
