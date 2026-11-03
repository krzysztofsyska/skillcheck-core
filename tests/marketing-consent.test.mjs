import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MARKETING_CONSENT_FIELD, MARKETING_CONSENT_TEXT, MARKETING_CONSENT_VALUE, MARKETING_CONSENT_VERSION,
  declaredMarketingConsent, hasMarketingConsent, isMarketingConsentActive, marketingConsentDeclaration,
} from '../lib/marketing-consent.ts';
import {
  signRegistrationConsentGrant, signedConsentDeclaration, verifiedConsentVersion,
} from '../lib/marketing-consent-signing.ts';

/** A server secret only this test knows; nothing is read from the environment. */
const ENV = { SC19_TRIAL_AUTO_SECRET: 's'.repeat(32) };
const COMPANY = '11111111-2222-3333-4444-555555555555';
/** A declared time in the canonical form signRegistrationConsentGrant signs. */
const DECLARED = '2026-11-03T08:00:00.000Z';

const migration = readFileSync(new URL('../supabase/migrations/20261103090000_sc19_auto_trial_marketing_consent.sql', import.meta.url), 'utf8');
const registerPage = readFileSync(new URL('../app/register/page.tsx', import.meta.url), 'utf8');
const consentPage = readFileSync(new URL('../app/dashboard/[companyId]/zgody/page.tsx', import.meta.url), 'utf8');
const consentActions = readFileSync(new URL('../app/dashboard/[companyId]/zgody/actions.ts', import.meta.url), 'utf8');
const authActions = readFileSync(new URL('../app/auth/actions.ts', import.meta.url), 'utf8');
const consentServer = readFileSync(new URL('../lib/marketing-consent-server.ts', import.meta.url), 'utf8');

const form = value => { const f = new FormData(); if (value !== undefined) f.set(MARKETING_CONSENT_FIELD, value); return f; };

test('the consent box is unticked by default and never required', () => {
  // An unticked checkbox sends no value at all: that is the default state.
  assert.equal(hasMarketingConsent(form()), false, 'absent field is no consent');
  assert.equal(hasMarketingConsent(form('')), false);
  assert.equal(hasMarketingConsent(form('on')), false, 'a generic browser value is not consent');
  assert.equal(hasMarketingConsent(form('v0.9')), false, 'another version is not consent');
  assert.equal(hasMarketingConsent(form(MARKETING_CONSENT_VALUE)), true);

  // The markup itself: one separate input, no `required`, no `checked`,
  // `defaultChecked` or `value={...true}` smuggling it in.
  const field = new RegExp(`<input type="checkbox" name=\\{MARKETING_CONSENT_FIELD\\}[^>]*/>`);
  const [input] = registerPage.match(field) ?? [];
  assert.ok(input, 'registration renders the marketing checkbox');
  assert.doesNotMatch(input, /required/, 'marketing consent must not be required');
  assert.doesNotMatch(input, /checked/i, 'marketing consent must not be pre-ticked');
});

test('the legal acceptance and the marketing consent are two separate boxes', () => {
  const inputs = registerPage.match(/<input type="checkbox"[^>]*\/>/g) ?? [];
  assert.equal(inputs.length, 2, 'exactly two checkboxes: terms and marketing');
  const [terms, marketing] = inputs;
  assert.match(terms, /LEGAL_ACCEPTANCE_FIELD/);
  assert.match(terms, /required/, 'the legal acceptance stays mandatory');
  assert.match(marketing, /MARKETING_CONSENT_FIELD/);
  // The marketing wording must not sit inside the Regulamin label.
  const termsLabel = registerPage.slice(registerPage.indexOf('LEGAL_ACCEPTANCE_FIELD'), registerPage.indexOf('MARKETING_CONSENT_FIELD'));
  assert.doesNotMatch(termsLabel, /kontakt handlowy/i, 'marketing is not bundled with the terms');
});

test('the stored wording is the database wording, byte for byte', () => {
  // The client names a version; the database supplies the text. If these two
  // ever drift, a consent record would claim wording nobody was shown.
  const inside = migration.match(/select case version when 'marketing-1\.0' then\n([\s\S]*?)\n  end;/);
  assert.ok(inside, 'migration defines private.marketing_consent_text');
  const sqlText = inside[1].split('\n').map(line => line.trim().replace(/^\|\|\s*/, ''))
    .map(line => line.replace(/^'/, '').replace(/'$/, '')).join('');
  assert.equal(sqlText, MARKETING_CONSENT_TEXT);
  assert.equal(MARKETING_CONSENT_VERSION, 'marketing-1.0');
  assert.ok(MARKETING_CONSENT_TEXT.includes('wycofać'), 'the wording states the right to withdraw');
  assert.ok(MARKETING_CONSENT_TEXT.includes('dobrowolna'), 'the wording states it is optional');
});

test('only a well-formed, correctly SIGNED grant of a known version is recorded', () => {
  const SUBJECT = 'firma@przyklad.pl';
  const granted = signedConsentDeclaration(true, SUBJECT, ENV, new Date('2026-11-03T08:00:00Z'));
  assert.equal(granted.granted, true);
  assert.equal(granted.version, MARKETING_CONSENT_VERSION);
  assert.equal(granted.declared_at, '2026-11-03T08:00:00.000Z');
  assert.match(granted.sig, /^[0-9a-f]{64}$/, 'the snapshot is signed');
  assert.deepEqual(verifiedConsentVersion({ marketing_consent: granted }, SUBJECT, ENV),
    { version: MARKETING_CONSENT_VERSION, declaredAt: '2026-11-03T08:00:00.000Z' });

  for (const metadata of [
    undefined, null, {}, 'string', [],
    { marketing_consent: null },
    { marketing_consent: signedConsentDeclaration(false, SUBJECT, ENV) },
    { marketing_consent: { granted: 'true', version: MARKETING_CONSENT_VERSION, declared_at: granted.declared_at, sig: granted.sig } },
    { marketing_consent: { granted: true } },
    { marketing_consent: { granted: true, version: 'marketing-9.9', declared_at: granted.declared_at, sig: granted.sig } },
  ]) {
    assert.equal(verifiedConsentVersion(metadata, SUBJECT, ENV), null, JSON.stringify(metadata));
  }

  // User metadata is client-writable, so a wording smuggled into the snapshot
  // must change nothing: only the VERSION is ever taken from here, and the text
  // stored with the event comes from private.marketing_consent_text.
  assert.equal(verifiedConsentVersion({ marketing_consent: { ...granted, consent_text: 'cokolwiek' } }, SUBJECT, ENV)?.version,
    MARKETING_CONSENT_VERSION, 'a stray wording field is ignored, not obeyed');
  assert.match(migration, /wording := private\.marketing_consent_text\(consent_version\)/);
  const grantFn = migration.slice(migration.indexOf('function public.marketing_consent_grant'), migration.indexOf('function public.marketing_consent_withdraw'));
  assert.doesNotMatch(grantFn, /consent_text text\b/, 'the RPC has no parameter for the wording at all');

  // The pure reader refuses everything without a verifier: an unverifiable
  // snapshot is treated exactly like a forged one.
  assert.equal(declaredMarketingConsent({ marketing_consent: granted }, { subject: SUBJECT }), null);
  assert.equal(marketingConsentDeclaration(true, {}).granted, false, 'no signer, no grant');
});

test('a consent the user wrote into their own metadata is NOT recorded', () => {
  // THE ATTACK. user_metadata is client-writable (auth.updateUser). After
  // confirming the address a user could set marketing_consent.granted = true
  // even though the optional box was left unticked, and the append-only ledger
  // would certify a consent that was never given. Under art. 7(1) GDPR the fact
  // of consent has to be demonstrable, so the snapshot is HMAC-signed and an
  // unsigned or edited one records nothing.
  const SUBJECT = 'firma@przyklad.pl';
  const real = signedConsentDeclaration(true, SUBJECT, ENV, new Date('2026-11-03T08:00:00Z'));
  const forgeries = {
    'no signature at all': { version: MARKETING_CONSENT_VERSION, granted: true, declared_at: real.declared_at },
    'empty signature': { ...real, sig: '' },
    'invented signature': { ...real, sig: 'f'.repeat(64) },
    'flipped a declined snapshot to granted': { ...signedConsentDeclaration(false, SUBJECT, ENV, new Date('2026-11-03T08:00:00Z')), granted: true },
    'kept the signature, moved the time': { ...real, declared_at: '2026-11-03T09:00:00.000Z' },
    'another version with a valid signature': { ...real, version: 'marketing-9.9' },
    'oversized signature': { ...real, sig: 'a'.repeat(400) },
  };
  for (const [label, marketing_consent] of Object.entries(forgeries)) {
    assert.equal(verifiedConsentVersion({ marketing_consent }, SUBJECT, ENV), null, label);
  }
  // Another account's valid snapshot does not work either.
  assert.equal(verifiedConsentVersion({ marketing_consent: real }, 'ktos.inny@przyklad.pl', ENV), null, 'bound to one account');
  // And without a server secret nothing is signed and nothing is recorded.
  assert.equal(signedConsentDeclaration(true, SUBJECT, {}).granted, false, 'no secret, no signed grant');
  assert.equal(verifiedConsentVersion({ marketing_consent: real }, SUBJECT, {}), null, 'no secret, nothing recorded');
  // The consent label is not one the database accepts, so a consent signature
  // can never be presented to an RPC.
  assert.doesNotMatch(migration, /not in \('auto_claim','auto_failure','digest','consent'\)/);
  assert.match(migration, /op not in \('auto_claim','auto_failure','digest','consent_registration'\)/);
  // 'consent_registration' is a DIFFERENT label over a DIFFERENT payload (the
  // company id and the version, not the snapshot), so the client-writable
  // snapshot signature still cannot be presented to the RPC.
  assert.notEqual(signRegistrationConsentGrant(COMPANY, MARKETING_CONSENT_VERSION, DECLARED, ENV).signature,
    signedConsentDeclaration(true, 'firma@przyklad.pl', ENV).sig);
});

test('the registration grant request is signed per company, version and declared time', () => {
  const a = signRegistrationConsentGrant(COMPANY, MARKETING_CONSENT_VERSION, DECLARED, ENV);
  assert.match(a.signature, /^[0-9a-f]{64}$/);
  assert.match(a.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(a.declaredAt, DECLARED, 'the canonical declared time travels with the request');
  // A fresh request id every time, so the database's nonce table makes a second
  // successful use of one request fail.
  assert.notEqual(signRegistrationConsentGrant(COMPANY, MARKETING_CONSENT_VERSION, DECLARED, ENV).requestId, a.requestId);
  // The company, the version AND the declared time are inside the signature: one
  // accepted request cannot be replayed for another company, another wording or
  // another moment. Without the time in the payload an owner reaching the RPC
  // through the Data API could choose the date his consent is recorded under.
  const again = (company, version, declaredAt) => signRegistrationConsentGrant(company, version, declaredAt, ENV);
  assert.notEqual(again('99999999-2222-3333-4444-555555555555', MARKETING_CONSENT_VERSION, DECLARED).signature, a.signature);
  assert.notEqual(again(COMPANY, 'marketing-9.9', DECLARED).signature, a.signature);
  assert.notEqual(again(COMPANY, MARKETING_CONSENT_VERSION, '2026-11-03T09:00:00.000Z').signature, a.signature,
    'moving the declared time changes the signature');
  assert.ok(a.issuedAtMs > 0);
  // An unusable declared time is signed as absent, not dropped: the database
  // then stamps the row with its own clock and the consent survives.
  const undated = again(COMPANY, MARKETING_CONSENT_VERSION, null);
  assert.equal(undated.declaredAt, null);
  assert.notEqual(undated.signature, a.signature);
  assert.equal(again(COMPANY, MARKETING_CONSENT_VERSION, 'nie-data').declaredAt, null);
  // Equivalent spellings of one instant canonicalise to the same UTC string, so
  // the payload the database rebuilds with to_char() cannot drift from the one
  // signed here. (The signatures themselves differ: each call mints a fresh
  // request id, which is also inside the HMAC.)
  assert.equal(again(COMPANY, MARKETING_CONSENT_VERSION, '2026-11-03T09:00:00.000+01:00').declaredAt,
    again(COMPANY, MARKETING_CONSENT_VERSION, '2026-11-03T08:00:00.000Z').declaredAt);
  assert.equal(again(COMPANY, MARKETING_CONSENT_VERSION, '2026-11-03T08:00:00Z').declaredAt, DECLARED);
  // No secret, no request: then nothing is recorded as a registration consent
  // and the owner gives it in the panel instead.
  assert.equal(signRegistrationConsentGrant(COMPANY, MARKETING_CONSENT_VERSION, DECLARED, {}), null);
  assert.equal(signRegistrationConsentGrant(COMPANY, MARKETING_CONSENT_VERSION, DECLARED, { SC19_TRIAL_AUTO_SECRET: 'zbyt-krotki' }), null);
});

test('the declared consent time survives into the ledger instead of the onboarding time', () => {
  // THE BUG (bot review finding, 2026-11-03). The snapshot's declared_at was
  // verified under the HMAC and then thrown away, and the ledger row took the
  // column default — so a consent ticked at sign-up was dated at onboarding,
  // which happens after e-mail confirmation and can be days later. The ledger
  // exists to prove WHEN the customer consented (GDPR art. 7(1)).
  const SUBJECT = 'firma@przyklad.pl';
  const granted = signedConsentDeclaration(true, SUBJECT, ENV, new Date('2026-08-01T06:30:00Z'));
  const verified = verifiedConsentVersion({ marketing_consent: granted }, SUBJECT, ENV);
  assert.equal(verified.declaredAt, '2026-08-01T06:30:00.000Z', 'the declared moment comes back, not now()');

  // A time that does not parse does not throw the consent away: it comes back as
  // null and the database stamps the row itself.
  const broken = signedConsentDeclaration(true, SUBJECT, ENV, new Date('2026-08-01T06:30:00Z'));
  const reader = (declared_at, sig) => declaredMarketingConsent({ marketing_consent: { ...broken, declared_at, sig } },
    { subject: SUBJECT, verify: () => true });
  assert.equal(reader('nie-data', broken.sig).declaredAt, null, 'unparseable time, consent still recorded');
  assert.equal(reader(broken.declared_at, broken.sig).declaredAt, '2026-08-01T06:30:00.000Z');

  // The action passes it on, and the RPC takes it as its own parameter.
  assert.match(authActions, /declared_at: signedGrant\.declaredAt/);
  assert.match(migration,
    /create function public\.marketing_consent_grant_registration\(\n\s*target_company uuid, consent_version text, declared_at timestamptz,/);
  // It is inside the signature the database rebuilds, so it cannot be chosen by
  // the caller.
  const registration = migration.slice(migration.indexOf('function public.marketing_consent_grant_registration'));
  const body = registration.slice(0, registration.indexOf('$$;'));
  assert.match(body, /to_char\(declared_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/);
  assert.match(body, /marketing_consent_record\(target_company, consent_version, 'registration', actor, declared_at\)/);
  // The ledger row is written with that time, not with the default.
  assert.match(migration, /values\(target_company,'granted',consent_version,wording,consent_source,actor,stamp\)/);
  // FAIL-SAFE and the stated bound: out of range keeps the consent at now().
  assert.match(migration, /stamp timestamptz := now\(\);/);
  assert.match(migration, /declared_at <= now\(\) \+ interval '60 seconds'/);
  assert.match(migration, /declared_at >= now\(\) - interval '90 days'/);
  // A panel click has no declared time; it is always stamped now().
  assert.match(migration, /marketing_consent_record\(target_company, consent_version, 'company_panel', actor, null\)/);
});

test('registration signs the snapshot and verifies it before recording, and sends nothing', () => {
  assert.match(authActions, /marketing_consent: signedConsentDeclaration\(hasMarketingConsent\(form\), input\.email\)/);
  // The source is not a parameter of either RPC any more: 'registration' is
  // written only by the signed function, so a signed-in owner calling the Data
  // API cannot have the ledger attribute his consent to sign-up.
  assert.match(authActions, /marketing_consent_grant_registration/);
  assert.doesNotMatch(authActions, /consent_source/);
  assert.match(authActions, /request_signature: signedGrant\.signature/);
  assert.match(migration, /create function public\.marketing_consent_grant\(target_company uuid, consent_version text\)\n/);
  const registration = migration.slice(migration.indexOf('function public.marketing_consent_grant_registration'));
  assert.match(registration.slice(0, registration.indexOf('$$;')),
    /sc19_trial_auto_verify_signature\('consent_registration'/, 'the signature is verified in the database');
  // Only a verified snapshot's version crosses into the ledger call.
  assert.match(authActions, /verifiedConsentVersion\(user\.user_metadata, user\.email\)/);
  assert.match(authActions, /signRegistrationConsentGrant\(companyId, consent\.version, consent\.declaredAt\)/);
  assert.doesNotMatch(authActions, /declaredMarketingConsent\(/, 'the unverified reader is not used by the action');
  assert.doesNotMatch(authActions, /resend|sendMail|api\.resend\.com/i, 'registration sends no mail');
  // The application imports the guarded module, so the secret can never be
  // bundled for the browser.
  assert.match(authActions, /from "\.\.\/\.\.\/lib\/marketing-consent-server"/);
  assert.match(consentServer, /^import 'server-only';/m);
  // And the unguarded form of the registration page never sees the secret.
  assert.doesNotMatch(registerPage, /SC19_TRIAL_AUTO_SECRET|marketing-consent-signing/);
});

test('withdrawal is one click, appends, and is owner-only', () => {
  assert.match(consentActions, /marketing_consent_withdraw/);
  // One form, one button, no confirmation step and no typed input.
  assert.match(consentPage, /\{active \? 'Wycofaj zgodę' : 'Wyrażam zgodę'\}/);
  assert.doesNotMatch(consentPage, /<input (?!type="hidden")/, 'the panel asks for nothing to be typed');
  assert.match(consentActions, /user\.id !== company\.owner_id/, 'only the owner may change consent');
  // Appending, not overwriting: the SQL inserts, and nothing updates or deletes.
  const grant = migration.slice(migration.indexOf('function private.marketing_consent_record'), migration.indexOf('function public.marketing_consent_state'));
  assert.match(grant, /insert into private\.marketing_consent_events/);
  assert.doesNotMatch(grant, /update private\.marketing_consent_events|delete from private\.marketing_consent_events/);
  assert.match(migration, /create trigger immutable_history before update or delete on private\.marketing_consent_events/);
});

test('nothing in the consent path can send to a company', () => {
  for (const [name, source] of Object.entries({
    consentPage, consentActions,
    'lib/marketing-consent.ts': readFileSync(new URL('../lib/marketing-consent.ts', import.meta.url), 'utf8'),
    'lib/marketing-consent-signing.ts': readFileSync(new URL('../lib/marketing-consent-signing.ts', import.meta.url), 'utf8'),
  })) {
    assert.doesNotMatch(source, /api\.resend\.com|RESEND_API_KEY|sendMail|smtp/i, name);
  }
  // No outbox, recipient column or provider reference in the consent schema.
  const table = migration.slice(migration.indexOf('create table private.marketing_consent_events'), migration.indexOf('create index marketing_consent_events_company'));
  for (const forbidden of ['email', 'recipient', 'outbox', 'provider', 'sent_at']) {
    assert.doesNotMatch(table, new RegExp(forbidden, 'i'), `consent ledger has no ${forbidden} column`);
  }
});

test('the current consent is decided by the write order, not by the declared time', () => {
  // Bot review finding 4458164489, 2026-11-03: occurred_at may legitimately sit
  // up to 60 s ahead of the database clock, and the old `id desc` tiebreak was a
  // random UUID, so a withdrawal could lose to the grant it followed. The real
  // behaviour is proved against PostgreSQL in tests/sc19-auto-trial-database.test.mjs;
  // this guard is here so nobody reintroduces the ordering in this file by hand.
  assert.match(migration, /recorded_seq bigint generated by default as identity/);
  assert.match(migration, /create index marketing_consent_events_company on private\.marketing_consent_events\(company_id, recorded_seq desc\)/);
  const readers = migration.slice(migration.indexOf('function private.marketing_consent_record'));
  assert.doesNotMatch(readers, /order by (e\.)?occurred_at desc/,
    'no consent-state lookup may order by occurred_at');
  assert.equal((readers.match(/order by (e\.)?recorded_seq desc limit 1/g) ?? []).length, 4,
    'all four single-event lookups (grant, withdraw, panel state, operator report) order by recorded_seq');
  // The daily digest COUNTS consents given inside a window: that is a question
  // about facts, so it stays on occurred_at and must not move to recorded_seq.
  const digest = migration.slice(migration.indexOf('function public.sc19_daily_digest'));
  assert.match(digest, /e\.occurred_at >= window_start and e\.occurred_at < window_end/);
});

test('the latest event decides the state shown', () => {
  const at = '2026-11-03T10:00:00Z';
  assert.equal(isMarketingConsentActive({ event: 'granted', consent_version: 'marketing-1.0', consent_text: 'x', occurred_at: at }), true);
  assert.equal(isMarketingConsentActive({ event: 'withdrawn', consent_version: 'marketing-1.0', consent_text: 'x', occurred_at: at }), false);
  assert.equal(isMarketingConsentActive(null), false);
  assert.equal(isMarketingConsentActive(undefined), false);
});

test('the privacy policy states the purpose, the basis and the right to withdraw', () => {
  const policy = readFileSync(new URL('../docs/legal/v1.0/02_Polityka_prywatnosci.md', import.meta.url), 'utf8');
  const row = policy.split('\n').find(line => line.startsWith('| Marketing własnych usług'));
  assert.ok(row, 'the purposes table has a marketing row');
  assert.match(row, /art\. 6 ust\. 1 lit\. a RODO/, 'consent as the legal basis');
  assert.match(row, /wycofać w każdej chwili/, 'the right to withdraw');
  assert.match(policy, /nie jest warunkiem rejestracji/);
  // Annex 1 (voice interviews) must not be touched by this change.
  const annex = readFileSync(new URL('../docs/legal/v1.0/06_Aneks_1_Rozmowy_glosowe.md', import.meta.url), 'utf8');
  assert.doesNotMatch(annex, /kontakt handlowy|marketing/i, 'Annex 1 is unchanged');
});
