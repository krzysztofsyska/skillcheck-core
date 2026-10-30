import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseLegalMarkdown, parseInline, hasLegalAcceptance, LEGAL_DOCUMENTS, LEGAL_VERSION, LEGAL_ACCEPTANCE_VALUE } from '../lib/legal.ts';

const dir = new URL(`../docs/legal/v${LEGAL_VERSION}/`, import.meta.url);

test('every published legal document exists, parses and has no draft markers', () => {
  const files = readdirSync(dir);
  for (const doc of Object.values(LEGAL_DOCUMENTS)) {
    assert.ok(files.includes(doc.file), doc.file);
    const source = readFileSync(new URL(doc.file, dir), 'utf8');
    assert.doesNotMatch(source, /NIE PUBLIKOWAĆ|PROJEKT|do zatwierdzenia/i, doc.file);
    const parsed = parseLegalMarkdown(source, '1 grudnia 2026 r.');
    assert.ok(parsed.title.length > 5, doc.file);
    assert.ok(parsed.blocks.length > 3, doc.file);
    assert.doesNotMatch(JSON.stringify(parsed), /\[DATA PUBLIKACJI\]/, doc.file);
    assert.doesNotMatch(JSON.stringify(parsed), /<[a-z]/i, `${doc.file} contains no raw HTML`);
  }
});

test('published documents carry the effective date 29.10.2026 and no date marker', () => {
  for (const doc of ['01_Regulamin_SkillCheck.md', '02_Polityka_prywatnosci.md', '03_Umowa_powierzenia_DPA.md', '05_AI_i_nadzor_czlowieka.md']) {
    const source = readFileSync(new URL(doc, dir), 'utf8');
    assert.doesNotMatch(source, /\[DATA PUBLIKACJI\]/, doc);
    assert.ok(source.includes('29.10.2026'), doc);
  }
});

test('company identifiers are identical across documents', () => {
  for (const doc of ['01_Regulamin_SkillCheck.md', '02_Polityka_prywatnosci.md', '03_Umowa_powierzenia_DPA.md']) {
    const source = readFileSync(new URL(doc, dir), 'utf8');
    for (const id of ['KRS 0001110252', 'NIP 7394002294', 'REGON 528903093', 'pomoc@skillcheck.pl']) assert.ok(source.includes(id), `${doc} ${id}`);
  }
});

test('regulamin parses ordered lists with sub-points and tables', () => {
  const reg = parseLegalMarkdown(readFileSync(new URL('01_Regulamin_SkillCheck.md', dir), 'utf8'));
  const payments = reg.blocks.find((b) => b.kind === 'ordered' && JSON.stringify(b).includes('Przelewy24'));
  assert.ok(payments.items[0].sub.length === 2, 'payment methods a) and b)');
  const policy = parseLegalMarkdown(readFileSync(new URL('02_Polityka_prywatnosci.md', dir), 'utf8'));
  const table = policy.blocks.find((b) => b.kind === 'table');
  assert.equal(table.header.length, 3);
  assert.ok(table.rows.length >= 6);
});

test('effective date replaces the marker without a double full stop', () => {
  const doc = parseLegalMarkdown('---\ntitle: T\n---\n\nObowiązuje od [DATA PUBLIKACJI].\n\nWersja · [DATA PUBLIKACJI]\n', '28 października 2026 r.');
  assert.equal(doc.blocks[0].text[0].text, 'Obowiązuje od 28 października 2026 r.');
  assert.equal(doc.blocks[1].text[0].text, 'Wersja · 28 października 2026 r.');
});

test('inline parser handles bold and italics only', () => {
  assert.deepEqual(parseInline('a **b** *c* <i>x</i>'), [
    { kind: 'text', text: 'a ' }, { kind: 'strong', text: 'b' }, { kind: 'text', text: ' ' }, { kind: 'em', text: 'c' }, { kind: 'text', text: ' <i>x</i>' },
  ]);
});

test('registration acceptance requires the exact current version value', () => {
  const form = (v) => { const f = new FormData(); if (v !== undefined) f.set('legal_acceptance', v); return f; };
  assert.equal(hasLegalAcceptance(form()), false);
  assert.equal(hasLegalAcceptance(form('on')), false);
  assert.equal(hasLegalAcceptance(form('v0.9')), false);
  assert.equal(hasLegalAcceptance(form(`v${LEGAL_VERSION}`)), false, 'stale form without Annex 1 is rejected');
  assert.equal(hasLegalAcceptance(form(LEGAL_ACCEPTANCE_VALUE)), true);
});

test('annex 1 (voice interviews) lists voice sub-processors, retention and no recording', () => {
  const source = readFileSync(new URL('06_Aneks_1_Rozmowy_glosowe.md', dir), 'utf8');
  for (const s of ['Retell AI, Inc.', 'Level 7 Systems Limited', '90 dni', 'nie jest nagrywana', '13.11.2026', 'pomoc@skillcheck.pl']) assert.ok(source.includes(s), s);
  const parsed = parseLegalMarkdown(source);
  const table = parsed.blocks.find((b) => b.kind === 'table');
  assert.equal(table.header.length, 3);
  assert.equal(table.rows.length, 3);
});
