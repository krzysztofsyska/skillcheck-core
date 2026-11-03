import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MARKETING_CONSENT_FIELD, MARKETING_CONSENT_TEXT, MARKETING_CONSENT_VALUE, MARKETING_CONSENT_VERSION,
  declaredMarketingConsent, hasMarketingConsent, isMarketingConsentActive, marketingConsentDeclaration,
} from '../lib/marketing-consent.ts';

const migration = readFileSync(new URL('../supabase/migrations/20261103090000_sc19_auto_trial_marketing_consent.sql', import.meta.url), 'utf8');
const registerPage = readFileSync(new URL('../app/register/page.tsx', import.meta.url), 'utf8');
const consentPage = readFileSync(new URL('../app/dashboard/[companyId]/zgody/page.tsx', import.meta.url), 'utf8');
const consentActions = readFileSync(new URL('../app/dashboard/[companyId]/zgody/actions.ts', import.meta.url), 'utf8');
const authActions = readFileSync(new URL('../app/auth/actions.ts', import.meta.url), 'utf8');

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

test('only a well-formed grant of a known version is recorded, and only its version', () => {
  const granted = marketingConsentDeclaration(true, new Date('2026-11-03T08:00:00Z'));
  assert.equal(granted.granted, true);
  assert.equal(granted.version, MARKETING_CONSENT_VERSION);
  assert.equal(granted.declared_at, '2026-11-03T08:00:00.000Z');
  assert.equal(declaredMarketingConsent({ marketing_consent: granted }), MARKETING_CONSENT_VERSION);

  for (const metadata of [
    undefined, null, {}, 'string', [],
    { marketing_consent: null },
    { marketing_consent: marketingConsentDeclaration(false) },
    { marketing_consent: { granted: 'true', version: MARKETING_CONSENT_VERSION } },
    { marketing_consent: { granted: true } },
    { marketing_consent: { granted: true, version: 'marketing-9.9' } },
    // User metadata is client-writable, so a forged wording must be ignored.
    { marketing_consent: { granted: true, version: MARKETING_CONSENT_VERSION, consent_text: 'cokolwiek' } },
  ]) {
    const result = declaredMarketingConsent(metadata);
    assert.ok(result === null || result === MARKETING_CONSENT_VERSION, JSON.stringify(metadata));
    if (result) assert.equal(result, MARKETING_CONSENT_VERSION, 'only the known version is ever returned');
  }
  assert.equal(declaredMarketingConsent({ marketing_consent: { granted: true, version: 'marketing-9.9' } }), null);
});

test('registration records the declaration without sending anything', () => {
  assert.match(authActions, /marketing_consent: marketingConsentDeclaration\(hasMarketingConsent\(form\)\)/);
  assert.match(authActions, /marketing_consent_grant/);
  assert.match(authActions, /consent_source: "registration"/);
  // Only the version crosses from the metadata into the ledger call.
  assert.match(authActions, /declaredMarketingConsent\(user\.user_metadata\)/);
  assert.doesNotMatch(authActions, /resend|sendMail|api\.resend\.com/i, 'registration sends no mail');
});

test('withdrawal is one click, appends, and is owner-only', () => {
  assert.match(consentActions, /marketing_consent_withdraw/);
  // One form, one button, no confirmation step and no typed input.
  assert.match(consentPage, /\{active \? 'Wycofaj zgodę' : 'Wyrażam zgodę'\}/);
  assert.doesNotMatch(consentPage, /<input (?!type="hidden")/, 'the panel asks for nothing to be typed');
  assert.match(consentActions, /user\.id !== company\.owner_id/, 'only the owner may change consent');
  // Appending, not overwriting: the SQL inserts, and nothing updates or deletes.
  const grant = migration.slice(migration.indexOf('function public.marketing_consent_grant'), migration.indexOf('function public.marketing_consent_state'));
  assert.match(grant, /insert into private\.marketing_consent_events/);
  assert.doesNotMatch(grant, /update private\.marketing_consent_events|delete from private\.marketing_consent_events/);
  assert.match(migration, /create trigger immutable_history before update or delete on private\.marketing_consent_events/);
});

test('nothing in the consent path can send to a company', () => {
  for (const [name, source] of Object.entries({ consentPage, consentActions, 'lib/marketing-consent.ts': readFileSync(new URL('../lib/marketing-consent.ts', import.meta.url), 'utf8') })) {
    assert.doesNotMatch(source, /api\.resend\.com|RESEND_API_KEY|sendMail|smtp/i, name);
  }
  // No outbox, recipient column or provider reference in the consent schema.
  const table = migration.slice(migration.indexOf('create table private.marketing_consent_events'), migration.indexOf('create index marketing_consent_events_company'));
  for (const forbidden of ['email', 'recipient', 'outbox', 'provider', 'sent_at']) {
    assert.doesNotMatch(table, new RegExp(forbidden, 'i'), `consent ledger has no ${forbidden} column`);
  }
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
