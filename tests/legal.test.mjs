import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseLegalMarkdown, parseInline, hasLegalAcceptance, LEGAL_DOCUMENTS, LEGAL_VERSION, LEGAL_ACCEPTANCE_VALUE, LEGAL_ACCEPTANCE_REVISION, LEGAL_ACCEPTED_DOCUMENTS } from '../lib/legal.ts';

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
  assert.equal(hasLegalAcceptance(form(`v${LEGAL_VERSION}`)), false, 'a bare version is rejected');
  assert.equal(hasLegalAcceptance(form('v1.0+aneks1')), false, 'a stale form from the Annex 1 consent is rejected');
  assert.equal(hasLegalAcceptance(form(LEGAL_ACCEPTANCE_VALUE)), true);
});

// Owner decision 2026-11-11: the voice annex is not part of the mandatory registration consent
// (the voicebot is not offered, CLAUDE.md "Voicebot on the public offer"). These tests pin the
// consent wording and its version so a later change cannot silently bring it back or reuse a version.
const repo = (path) => new URL(`../${path}`, import.meta.url);
const consentLabel = () => {
  const page = readFileSync(repo('app/register/page.tsx'), 'utf8');
  const start = page.indexOf('name={LEGAL_ACCEPTANCE_FIELD}');
  const end = page.indexOf('</label>', start);
  assert.ok(start > 0 && end > start, 'the mandatory consent label is found on /register');
  return page.slice(start, end);
};

test('the consent version is r2, differs from the Annex 1 consent, and the documents match the label', () => {
  assert.equal(LEGAL_ACCEPTANCE_REVISION, '1.0+r2');
  assert.equal(LEGAL_ACCEPTANCE_VALUE, 'v1.0+r2');
  assert.notEqual(LEGAL_ACCEPTANCE_REVISION, `${LEGAL_VERSION}+aneks1`, 'changed wording must not reuse the old revision');
  assert.deepEqual([...LEGAL_ACCEPTED_DOCUMENTS], ['regulamin', 'dpa', 'polityka-prywatnosci']);
  const label = consentLabel();
  for (const href of ['/regulamin"', '/regulamin/umowa-powierzenia"', '/polityka-prywatnosci"']) assert.ok(label.includes(`href="${href}`), href);
  assert.equal((label.match(/<Link /g) ?? []).length, LEGAL_ACCEPTED_DOCUMENTS.length, 'one link per accepted document');
});

test('the mandatory registration consent does not mention or link the voice annex', () => {
  const label = consentLabel();
  assert.doesNotMatch(label, /aneks|g[łl]osow|voice|asystent/i);
  assert.match(label, /upoważniony\/a/, 'the authority statement stays');
});

// Owner decision 2026-11-11 ("wycofaj z publikacji"): the voice annex is withdrawn. These tests keep
// it withdrawn: no route, no download, no registry entry, and nothing that links to it. The scan covers
// code AND content/docs (the first version of this check only looked at app, components and lib).
const ANNEX_FILE = '06_Aneks_1_Rozmowy_glosowe';
const archiveDir = new URL('../docs/legal/withdrawn/v1.0/', import.meta.url);
const walk = (dir, skip = () => false) => existsSync(repo(dir)) ? readdirSync(repo(dir), { withFileTypes: true }).flatMap((e) => {
  const p = `${dir}/${e.name}`;
  if (skip(p)) return [];
  return e.isDirectory() ? walk(p, skip) : [p];
}) : [];

test('the voice annex is not published: no page, no download, no registry entry', () => {
  assert.equal(existsSync(repo('app/regulamin/aneks-rozmowy-glosowe')), false, 'the annex route is removed (the site answers 404)');
  assert.deepEqual(walk('app').filter((p) => /aneks/i.test(p)), [], 'no route or component named after an annex');
  assert.deepEqual(walk('public').filter((p) => p.includes(ANNEX_FILE)), [], 'the annex .docx is not in public/');
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('Aneks')), [], 'the annex is not among the published texts');
  assert.deepEqual(Object.keys(LEGAL_DOCUMENTS).sort(), ['ai', 'dpa', 'odstapienie', 'prywatnosc', 'regulamin']);
  assert.ok(!Object.values(LEGAL_DOCUMENTS).some((d) => /aneks/i.test(d.file + d.docx + d.href)), 'no registry entry points at the annex');
});

test('nothing in code, content, docs, public or config links to the voice annex', () => {
  const roots = ['app', 'lib', 'content', 'docs', 'supabase', 'scripts', 'tools', 'config', 'public'];
  const textFile = (p) => /\.(tsx?|mjs|cjs|js|json|md|html|css|sql|txt|xml|ya?ml)$/i.test(p);
  const skip = (p) => p.startsWith('docs/legal/withdrawn'); // the archive itself
  const linkPattern = /aneks-rozmowy-glosowe|aneks-1-|LEGAL_DOCUMENTS\.aneks1|documentKey=["{']aneks1|legal\/06_Aneks|(?:docs|public)\/legal\/(?:v\d[\w.]*\/)?06_Aneks|\baneks1\s*:/i;
  const hits = roots.flatMap((r) => walk(r, skip)).filter(textFile)
    .filter((p) => linkPattern.test(readFileSync(repo(p), 'utf8')));
  assert.deepEqual(hits, [], 'nothing refers to the annex route, its registry key or its old file locations');
  for (const file of ['next.config.mjs', 'vercel.json', 'proxy.ts']) {
    if (existsSync(repo(file))) assert.doesNotMatch(readFileSync(repo(file), 'utf8'), linkPattern, file);
  }
  // The registration form and the account/footer surfaces never name it either.
  const surfaces = walk('app').filter((p) => /\.(tsx?)$/.test(p))
    .filter((p) => /Aneks(em)? nr 1|aneks-rozmowy/i.test(readFileSync(repo(p), 'utf8')));
  assert.deepEqual(surfaces, []);
});

test('the voice annex is archived byte-for-byte with a withdrawal note', () => {
  const md = readFileSync(new URL(`${ANNEX_FILE}.md`, archiveDir));
  const docx = readFileSync(new URL(`${ANNEX_FILE}_v1.0.docx`, archiveDir));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  assert.equal(sha(md), '8b77ca11877b74b094fa22f80c2768b3d6190efb9b2442174b1902738134e2bb', 'annex wording is unchanged');
  assert.equal(sha(docx), 'b891fd1287619dfda9e3ffce0813286dc05840abb7d7de939c63d08eba3a5499', 'annex .docx is unchanged');
  const note = readFileSync(new URL('../README.md', archiveDir), 'utf8');
  for (const s of ['WYCOFANY Z PUBLIKACJI 11.11.2026', 'nie został przez nikogo zaakceptowany', '13.11.2026', '7 kont']) assert.ok(note.includes(s), s);
});

test('the Regulamin and the DPA do not make the voice annex mandatory', () => {
  for (const file of ['01_Regulamin_SkillCheck.md', '03_Umowa_powierzenia_DPA.md']) {
    assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), /Aneks/, file);
  }
});

test('the archived annex 1 (voice interviews) lists voice sub-processors, retention and no recording', () => {
  const source = readFileSync(new URL('06_Aneks_1_Rozmowy_glosowe.md', archiveDir), 'utf8');
  for (const s of ['Retell AI, Inc.', 'Level 7 Systems Limited', '90 dni', 'nie jest nagrywana', '13.11.2026', 'pomoc@skillcheck.pl']) assert.ok(source.includes(s), s);
  const parsed = parseLegalMarkdown(source);
  const table = parsed.blocks.find((b) => b.kind === 'table');
  assert.equal(table.header.length, 3);
  assert.equal(table.rows.length, 3);
});
