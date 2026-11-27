// R8 SC-020 krok 1 (SC-020a) — test końcowy dwóch marek white-label w bazie.
// Dwie fikcyjne firmy, każda z własnym logo, własnymi kolorami, własną nazwą
// marki w raporcie i własnym adresem strony (domena klienta). Sprawdzamy, że
// każda firma (właściciel, rekruter, osoba tylko do odczytu) widzi wyłącznie
// swoją markę i swoje dane, że adres strony prowadzi do właściwej firmy, oraz
// że sama kontrola wykrywa wyciek (dowód negatywny).
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, rola `authenticated` z RLS
// (jak w Supabase), dane wyłącznie syntetyczne. Test niczego nie zmienia
// w schemacie: gdyby wykrył wyciek, ma się wywalić, a naprawa to osobne zadanie (L3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootWhiteLabel, users } from './helpers/white-label-fixture.mjs';
import { reportTitle, setupTwoBrands } from './helpers/white-label-two-brands.mjs';

/**
 * The check under test: a company's view must carry its own brand and its own data, and
 * nothing that identifies the other company (name, brand, colours, logo, host, ids, candidates).
 */
export function assertOnlyOwn(view, own, other, label) {
  assert.equal(view.companyId, own.companyId, `${label}: site address leads to its own company`);
  assert.ok(view.brand, `${label}: own brand is published and readable`);
  assert.equal(view.brand.config.brandName, own.brandName, `${label}: own brand name`);
  assert.deepEqual(view.brand.config.colors, own.colors, `${label}: own colours`);
  assert.equal(view.brand.config.recruiterPanel.headerStyle, own.headerStyle, `${label}: own header style`);
  assert.equal(view.brand.logo_asset_id, own.logo.assetId, `${label}: own logo`);
  assert.equal(view.logo?.sha256, own.logo.sha, `${label}: own logo file`);
  assert.equal(view.reportTitle, reportTitle(own.brandName), `${label}: report in own brand`);
  assert.ok(view.candidates.length > 0 && view.report.length > 0, `${label}: own data is visible`);
  assert.ok(view.candidates.includes(own.candidateName), `${label}: own candidate visible`);
  for (const rows of [view.companies, view.recruitments, view.applications, view.documents]) {
    assert.ok(rows.length > 0 && rows.every(companyId => companyId === own.companyId), `${label}: only own rows ${JSON.stringify(rows)}`);
  }
  const text = JSON.stringify(view).toLowerCase();
  for (const marker of [other.companyId, other.company, other.brandName, other.host, other.candidateName, other.recruitmentName,
    other.logo.assetId, other.logo.sha, other.logo.path, other.colors.primary, other.colors.accent]) {
    assert.ok(!text.includes(String(marker).toLowerCase()), `${label}: leak of the other company (${marker})`);
  }
}

test('SC-020a two white-label brands: each company sees only its own logo, colours, report, address and data', async t => {
  const e = await bootWhiteLabel(t);
  const { db, h } = e;
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  /** A cross-tenant call must fail with a permission error or return no rows. */
  const refusedOrEmpty = async (label, sql, args) => {
    let result;
    try { result = await db.query(sql, args); } catch (err) { assert.equal(err.code, '42501', `${label}: ${err.message}`); return; }
    assert.equal(result.rows.length, 0, `${label}: returned ${JSON.stringify(result.rows).slice(0, 200)}`);
  };
  const tenant = await setupTwoBrands(e);
  const members = { A: [users.owner, users.recruiter, users.viewer], B: [users.otherOwner] };

  /** Everything one member sees after opening the company's own site address, through the same calls the app uses. */
  const viewThrough = async (host, userId) => {
    const companyId = await e.resolve(host); // anonymous host lookup, as the proxy does
    await e.as(userId);
    const brand = (await rows('select * from public.brand_published($1)', [companyId]))[0] ?? null;
    const logo = brand?.logo_asset_id ? (await rows('select * from public.brand_asset($1,$2)', [companyId, brand.logo_asset_id]))[0] ?? null : null;
    const ids = async table => (await rows(`select company_id::text v from public.${table} order by 1`)).map(r => r.v);
    return {
      companyId, brand, logo,
      reportTitle: brand ? reportTitle(brand.config.brandName) : reportTitle('SkillCheck'),
      storage: (await rows("select name from storage.objects where bucket_id='brand-assets' order by 1")).map(r => r.name),
      companies: (await rows('select id::text v, name from public.companies order by 1')).map(r => r.v),
      companyNames: (await rows('select name from public.companies order by 1')).map(r => r.name),
      recruitments: await ids('recruitments'),
      recruitmentNames: (await rows('select name from public.recruitments order by 1')).map(r => r.name),
      applications: await ids('applications'),
      documents: await ids('candidate_documents'),
      candidates: (await rows('select last_name from public.candidates order by 1')).map(r => r.last_name),
      report: await rows(`select r.application_id, r.rank from public.recruitments x, public.get_screening_ranking(x.id, null) r
        where x.company_id=$1 order by 1`, [companyId]),
    };
  };

  await t.test('each site address resolves to its own company only; unknown host resolves to nothing', async () => {
    assert.equal(await e.resolve(tenant.A.host), tenant.A.companyId);
    assert.equal(await e.resolve(tenant.B.host), tenant.B.companyId);
    assert.equal(await e.resolve('kariera.nieznana-firma-test.pl'), null);
  });

  await t.test('every member sees only its own brand (logo, colours, report title) and its own data', async () => {
    for (const [key, otherKey] of [['A', 'B'], ['B', 'A']]) {
      for (const userId of members[key]) {
        const view = await viewThrough(tenant[key].host, userId);
        assertOnlyOwn(view, tenant[key], tenant[otherKey], `${key} as ${userId}`);
        assert.ok(view.report.some(r => r.rank === 1), `${key}: report has a ranked candidate`);
        assert.ok(view.storage.every(name => name.startsWith(`${tenant[key].companyId}/`)), `${key}: storage objects only own`);
      }
    }
  });

  await t.test('direct attempts at the other company brand, logo, report and data are refused or empty', async () => {
    for (const [key, otherKey] of [['A', 'B'], ['B', 'A']]) {
      const other = tenant[otherKey];
      for (const userId of members[key]) {
        await e.as(userId);
        for (const [sql, args] of [
          ['select * from public.brand_published($1)', [other.companyId]],
          ['select * from public.brand_asset($1,$2)', [other.companyId, other.logo.assetId]],
          ['select * from public.brand_asset($1,$2)', [tenant[key].companyId, other.logo.assetId]],
          ['select * from public.get_screening_ranking($1,null)', [other.recruitment.id]],
          ['select name from storage.objects where name=$1', [other.logo.path]],
          ['select last_name from public.candidates where company_id=$1', [other.companyId]],
          ['select name from public.companies where id=$1', [other.companyId]],
        ]) await refusedOrEmpty(`${key} as ${userId}: ${sql}`, sql, args);
      }
    }
  });

  await t.test('an outsider and an anonymous visitor on a company address see no brand and no data', async () => {
    for (const key of ['A', 'B']) {
      const companyId = await e.resolve(tenant[key].host);
      for (const asWho of [() => e.as(users.outsider), () => h.asUser(null, 'anon')]) {
        await asWho();
        await assert.rejects(db.query('select * from public.brand_published($1)', [companyId]), err => ['42501'].includes(err.code));
        const visible = await rows('select 1 from public.candidates').catch(err => { assert.equal(err.code, '42501'); return []; });
        assert.equal(visible.length, 0);
      }
    }
  });

  await t.test('negative proof: the check fails when a view carries the other company brand or data', async () => {
    const good = await viewThrough(tenant.A.host, users.owner);
    assertOnlyOwn(good, tenant.A, tenant.B, 'control');
    const leaks = {
      'foreign brand name': v => { v.brand.config.brandName = tenant.B.brandName; },
      'foreign colours': v => { v.brand.config.colors = { ...tenant.B.colors }; },
      'foreign logo': v => { v.brand.logo_asset_id = tenant.B.logo.assetId; },
      'foreign report title': v => { v.reportTitle = reportTitle(tenant.B.brandName); },
      'foreign site address': v => { v.companyId = tenant.B.companyId; },
      'foreign candidate': v => { v.candidates.push(tenant.B.candidateName); },
      'foreign row': v => { v.applications.push(tenant.B.companyId); },
      'foreign storage object': v => { v.storage.push(tenant.B.logo.path); },
    };
    for (const [name, inject] of Object.entries(leaks)) {
      const leaked = structuredClone(good);
      inject(leaked);
      assert.throws(() => assertOnlyOwn(leaked, tenant.A, tenant.B, name), { code: 'ERR_ASSERTION' }, `check must flag: ${name}`);
    }
    // The direct-attempt helper flags a call that reaches data (own company used as the stand-in for a leak).
    await e.as(users.owner);
    await assert.rejects(refusedOrEmpty('negative proof', 'select last_name from public.candidates where company_id=$1', [tenant.A.companyId]),
      { code: 'ERR_ASSERTION' });
    await assert.rejects(refusedOrEmpty('negative proof', 'select * from public.brand_published($1)', [tenant.A.companyId]), { code: 'ERR_ASSERTION' });
    // A real leaking read path: a role that bypasses RLS sees both companies and must be flagged.
    await h.asAdmin();
    const unrestricted = { ...good, candidates: (await rows('select last_name from public.candidates order by 1')).map(r => r.last_name) };
    assert.ok(unrestricted.candidates.includes(tenant.B.candidateName));
    assert.throws(() => assertOnlyOwn(unrestricted, tenant.A, tenant.B, 'unrestricted read'), { code: 'ERR_ASSERTION' });
  });
});
