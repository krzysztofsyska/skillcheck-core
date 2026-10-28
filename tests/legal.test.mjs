import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseLegalMarkdown, parseInline, hasLegalAcceptance, LEGAL_DOCUMENTS, LEGAL_VERSION } from '../lib/legal.ts';

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
  assert.equal(hasLegalAcceptance(form(`v${LEGAL_VERSION}`)), true);
});
