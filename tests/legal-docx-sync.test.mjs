import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { LEGAL_DOCUMENTS, LEGAL_VERSION } from '../lib/legal.ts';

/** The .docx files under public/legal are what a company downloads and keeps;
 * docs/legal/v<version> is what the site renders. The two are kept in step BY
 * HAND, and until this test nothing checked it: a Markdown change could ship
 * while the downloadable document still said something else — for a Regulamin,
 * a DPA and a privacy notice, that is the published terms disagreeing with
 * themselves.
 *
 * WHAT IS COMPARED. Not bytes: a .docx carries styles and numbering that the
 * Markdown does not. Every substantive sentence of the Markdown must appear in
 * the document's text. That is the direction that matters — a paragraph added to
 * the Markdown and forgotten in the .docx is exactly the failure that happened.
 */

const dir = new URL(`../docs/legal/v${LEGAL_VERSION}/`, import.meta.url);
const publicDir = new URL('../public/legal/', import.meta.url);

/** Plain text of word/document.xml: <w:t> runs joined, paragraphs separated.
 * A single forward scan, so crafted input cannot cause regex backtracking. */
function docxText(xml) {
  const decode = value => value.replace(/&(lt|gt|quot|apos|amp|#39);/g,
    (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', '#39': "'" })[e]);
  const out = [];
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf('<', i);
    if (open < 0) break;
    const close = xml.indexOf('>', open + 1);
    if (close < 0) break;
    const tag = xml.slice(open + 1, close);
    if (tag === 'w:t' || tag.startsWith('w:t ')) {
      const end = xml.indexOf('</w:t>', close + 1);
      if (end < 0) break;
      out.push(decode(xml.slice(close + 1, end)));
      i = end + 6;
      continue;
    }
    if (tag.startsWith('w:p') && !tag.startsWith('w:pPr')) out.push('\n');
    if (tag === 'w:tab' || tag === 'w:tab/' || tag === 'w:br/') out.push(' ');
    i = close + 1;
  }
  return out.join('');
}

/** Markdown markup removed, whitespace collapsed, typographic variants folded,
 * so the comparison is about words and not about how either file encodes a dash
 * or a quote. */
function normalize(value) {
  return value
    .replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sentences a published document must contain: body paragraphs, list items
 * and table cells. Front matter, the markup of table rules and anything shorter
 * than a clause are left out — they carry no obligation. */
function claims(markdown) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const pieces = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^[-|: ]+$/.test(line)) continue;
    if (line.startsWith('#')) { pieces.push(line.replace(/^#+\s*/, '')); continue; }
    if (line.startsWith('|')) {
      for (const cell of line.split('|')) pieces.push(cell);
      continue;
    }
    // List markers are stripped: Word renders them from its own numbering
    // definition, so the literal "- ", "1. " or "a) " is not in the text.
    pieces.push(line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^[a-z][.)]\s+/, ''));
  }
  // 40 characters is about one clause: long enough that a match is meaningful,
  // short enough that every real sentence of these documents is checked.
  return pieces.map(normalize).filter(piece => piece.length >= 40);
}

const docxFor = markdownFile =>
  `${markdownFile.replace(/\.md$/, '')}_v${LEGAL_VERSION}.docx`;

test('every published .docx carries the same wording as its Markdown source', async () => {
  const documents = Object.values(LEGAL_DOCUMENTS);
  assert.ok(documents.length >= 5, 'the legal set is not empty');
  for (const doc of documents) {
    const markdown = readFileSync(new URL(doc.file, dir), 'utf8');
    const name = docxFor(doc.file);
    const zip = await JSZip.loadAsync(readFileSync(new URL(name, publicDir)));
    const entry = zip.file('word/document.xml');
    assert.ok(entry, `${name} is a readable .docx`);
    const text = normalize(docxText(await entry.async('string')));
    assert.ok(text.length > 500, `${name} has extractable text`);

    const missing = claims(markdown).filter(claim => !text.includes(claim));
    assert.deepEqual(missing, [],
      `${name} is out of step with ${doc.file}. Regenerate the .docx from the Markdown; `
      + 'these passages are in the Markdown and not in the downloadable document');
  }
});

test('the .docx set and the Markdown set are the same documents', async () => {
  // A Markdown file with no .docx, or the other way round, means the site and
  // the download offer different sets of terms.
  const { readdirSync } = await import('node:fs');
  const expected = Object.values(LEGAL_DOCUMENTS).map(doc => docxFor(doc.file)).sort();
  const actual = readdirSync(publicDir).filter(name => name.endsWith('.docx')).sort();
  assert.deepEqual(actual, expected);
});
