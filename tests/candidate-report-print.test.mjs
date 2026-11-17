// SC-015-C — arkusz wydruku i przycisk PDF na stronie raportu kandydata.
// Testy źródłowe: sprawdzają układ strony i arkusza CSS, bez danych kandydata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageDir = 'app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/report';
const page = readFileSync(new URL(`../${pageDir}/page.tsx`, import.meta.url), 'utf8');
const css = readFileSync(new URL(`../${pageDir}/candidate-report-print.module.css`, import.meta.url), 'utf8');
const disclaimer = 'Raport wspiera ocenę człowieka i nie jest decyzją o zatrudnieniu. Decyzję podejmuje rekruter.';

test('strona importuje wspólny przycisk PrintReportButton i renderuje go', () => {
  assert.match(page, /import \{ PrintReportButton \} from '\.\.\/\.\.\/\.\.\/report\/print-button';/);
  assert.match(page, /<PrintReportButton \/>/);
});

test('arkusz CSS ma @media print, A4 i unikanie podziałów stron w kartach', () => {
  assert.match(css, /@media print/);
  assert.match(css, /size: A4/);
  assert.match(css, /break-inside: avoid/);
  assert.match(css, /overflow-wrap: anywhere/);
});

test('nawigacja, przycisk, eksport CSV, historia eksportu i dalsze kroki są oznaczone jako no-print', () => {
  assert.match(page, /<Link href=\{base\} className=\{printStyles\.noPrint\}>← Rekrutacja<\/Link>/);
  assert.match(page, /<div className=\{printStyles\.noPrint\}><PrintReportButton \/><\/div>/);
  assert.match(page, /<p className=\{printStyles\.noPrint\}><a href=\{`\$\{base\}\/applications\/\$\{applicationId\}\/report\/export`\}/);
  assert.match(page, /<details className=\{printStyles\.noPrint\}>\s*\n\s*<summary>Historia eksportu<\/summary>/);
  assert.match(page, /<div className=\{printStyles\.noPrint\}>\s*\n\s*<h2>Dalsze kroki<\/h2>/);
  assert.match(css, /\.noPrint \{ display: none !important; \}/);
});

test('stopka z dopiskiem o nie-decyzji jest zawsze renderowana, poza elementami no-print', () => {
  assert.ok(page.includes(disclaimer), 'brak tekstu stopki');
  // Stopka nie może mieć klasy no-print ani leżeć w bloku "Dalsze kroki".
  assert.doesNotMatch(page, /<footer className=\{printStyles\.noPrint\}/);
  assert.match(page, /<\/div>\s*\n\s*\n\s*\{\/\* SC-015-C[^*]*\*\/\}\s*\n\s*<footer className=\{printStyles\.footer\}>/);
  assert.doesNotMatch(css, /\.footer \{[^}]*display: none/);
});

test('górna informacja o nie-decyzji zostaje na stronie', () => {
  assert.match(page, /Nie jest decyzją o zatrudnieniu i nie zawiera wyniku ogólnego/);
});

test('R2-B: sekcja testu kompetencji jest na wydruku, dzieli się między kryteriami, treść jako tekst', () => {
  assert.match(page, /<CompetencySection section=\{competency\}/);
  assert.match(page, /<h2>Test kompetencji<\/h2>/);
  assert.match(page, /printStyles\.competencyTest/);
  assert.match(css, /\.competencyTest \{[^}]*border/);
  // Cytat kandydata to zwykły tekst w JSX, nigdy HTML.
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  // Sekcja jest przed blokiem „Dalsze kroki", a nie w nim (inaczej znikałaby z wydruku).
  assert.ok(page.indexOf('<CompetencySection') < page.indexOf('<h2>Dalsze kroki</h2>'));
  // Bez wyniku zbiorczego rubryki w raporcie.
  assert.doesNotMatch(page, /\.score\b/);
});
