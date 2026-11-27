// R8 SC-020a — wspólne dane dwóch fikcyjnych marek white-label (logo, kolory,
// nazwa marki w raporcie, adres strony, kandydat) dla testu bazy i testu na
// prawdziwym `next start`. Tylko dane syntetyczne; hosty nigdy nie trafiają do DNS.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { brandConfig, users } from './white-label-fixture.mjs';

/** A valid 1x1 RGB PNG of one colour, so the two logos really differ byte for byte. */
export function solidPng([r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))), chunk('IEND', Buffer.alloc(0))]);
}

// Two fictional companies. Every value is synthetic; the hosts are never resolved in DNS.
export const BRANDS = {
  A: {
    company: 'Alfa Logistyka (fikcyjna)', brandName: 'Alfa Kariera', host: 'kariera.alfa-logistyka-test.pl',
    colors: { primary: '#0b5d1e', onPrimary: '#ffffff', background: '#ffffff', text: '#111827', accent: '#9a3412' },
    headerStyle: 'primary', logoRgb: [11, 93, 30], candidateName: 'Zielinska-Alfa', recruitmentName: 'Magazynier Alfa',
  },
  B: {
    company: 'Beta Finanse (fikcyjna)', brandName: 'Beta Talenty', host: 'praca.beta-finanse-test.pl',
    colors: { primary: '#5b1a8a', onPrimary: '#ffffff', background: '#fdfcff', text: '#1f2937', accent: '#0e7490' },
    headerStyle: 'light', logoRgb: [91, 26, 138], candidateName: 'Nowakowski-Beta', recruitmentName: 'Analityk Beta',
  },
};
/** The report title rule of lib/brand-server.ts brandedTitle(): "<page> | <brand name>". */
export const reportTitle = brandName => `Raport preselekcji | ${brandName}`;

/**
 * On a bootWhiteLabel() environment: each fictional company gets its own name, logo file,
 * colours, published brand, active customer domain and an analysed, reviewed candidate.
 * Returns { A, B } with the fixture tenant fields plus logo { assetId, path, sha, bytes } and
 * reportedApplicationId (the analysed candidate that appears in the report).
 */
export async function setupTwoBrands(e) {
  const { db, h, a, b } = e;
  const tenant = { A: { ...BRANDS.A, ...a, owner: users.owner }, B: { ...BRANDS.B, ...b, owner: users.otherOwner } };
  for (const key of ['A', 'B']) {
    const own = tenant[key];
    await h.asAdmin();
    await db.query('update public.companies set name=$2 where id=$1', [own.companyId, own.company]);
    await db.query('update public.recruitments set name=$2 where id=$1', [own.recruitment.id, own.recruitmentName]);
    // Test-only analysis credit in this disposable database, so one screening analysis can feed the report.
    await db.query("insert into private.sc19_balances(company_id,plan,available) values($1,'FREE',5) on conflict(company_id) do update set available=5", [own.companyId]);
    const bytes = solidPng(own.logoRgb);
    const path = `${own.companyId}/logo/${randomUUID()}.png`;
    const sha = createHash('sha256').update(bytes).digest('hex');
    await e.as(own.owner);
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('brand-assets',$1,jsonb_build_object('size',$2::int,'mimetype','application/octet-stream'))",
      [path, bytes.length]);
    const assetId = await e.one('select public.brand_register_asset($1,$2,$3,$4,$5,$6)', [own.companyId, 'logo', path, 'image/png', bytes.length, sha]);
    own.logo = { assetId, path, sha, bytes };
    const config = brandConfig(own.brandName, { colors: own.colors, recruiterPanel: { headerStyle: own.headerStyle } });
    await e.one('select public.brand_save_draft($1,$2,$3,$4)', [own.companyId, JSON.stringify(config), assetId, null]);
    const state = await e.one('select public.brand_editor_state($1)', [own.companyId]);
    await e.one('select public.brand_publish_draft($1,$2,$3)', [own.companyId, state.draft.id, state.draft.updated_at]);
    await e.activeDomain(own.companyId, own.host);
    const extra = await h.candidate({ owner: own.owner, companyId: own.companyId, position: own.position, recruitment: own.recruitment }, own.candidateName);
    await h.completedApplication(extra, Array(5).fill('meets'));
    own.reportedApplicationId = extra.application.id;
  }
  assert.notDeepEqual(tenant.A.logo.bytes, tenant.B.logo.bytes, 'the two logos are different files');
  assert.notEqual(tenant.A.colors.primary, tenant.B.colors.primary);
  await h.asAdmin();
  return tenant;
}
