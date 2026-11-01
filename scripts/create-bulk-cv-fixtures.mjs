// Synthetic 60-file bulk CV package for preview tests (fictional people only).
// Usage: node scripts/create-bulk-cv-fixtures.mjs <out.zip>
import { writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { docx, protectedPdf, renderCv, scannedPdf, textPdf } from '../tests/helpers/cv-bulk-fixtures.mjs';

const first = ['Anna', 'Piotr', 'Maria', 'Tomasz', 'Ewa', 'Michał', 'Katarzyna', 'Paweł', 'Agnieszka', 'Marcin', 'Joanna', 'Krzysztof', 'Magdalena', 'Łukasz', 'Monika', 'Adam'];
const last = ['Testowa', 'Przykładowy', 'Fikcyjna', 'Próbny', 'Wzorcowa', 'Makietowy', 'Szablonowa', 'Demonstracyjny'];
const skills = [['SQL', 'Excel', 'raportowanie'], ['obsługa klienta', 'CRM', 'negocjacje'], ['księgowość', 'kadry', 'płace'], ['logistyka', 'magazyn', 'WMS']];
// Unique first/last name pair for i < 128; every 4th CV has no phone number.
const person = i => {
  const f = first[i % first.length], l = last[(i + Math.floor(i / first.length)) % last.length];
  const s = skills[i % skills.length];
  const email = `${f.toLowerCase().replace('ł', 'l')}.kandydat${i}@example.com`;
  const lines = [`${f} ${l}`, i % 4 === 3 ? 'Kontakt: e-mail' : `tel. +48 ${600 + i} ${100 + i} ${200 + i}`, email,
    `Doświadczenie: ${s.join(', ')} — ${2 + (i % 8)} lat pracy`,
    `Specjalista ds. ${s[0]}, firma Przykład Sp. z o.o., 2018-2024`, 'Wykształcenie: wyższe ekonomiczne', 'Języki: angielski B2'];
  return { name: `${f}_${l}_${i}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/gi, 'l'), lines, email };
};

const zip = new JSZip();
let n = 0;
const add = (name, data) => { zip.file(`paczka/${String(++n).padStart(2, '0')}_${name}`, data); };
let i = 0;
for (let k = 0; k < 32; k++, i++) { const p = person(i); add(`${p.name}.pdf`, textPdf(p.lines)); }
for (let k = 0; k < 6; k++, i++) { const p = person(i); add(`${p.name}.docx`, await docx(p.lines.slice(3), p.lines.slice(0, 3))); }
for (let k = 0; k < 3; k++, i++) { const p = person(i); add(`${p.name}.txt`, p.lines.join('\n')); }
for (let k = 0; k < 4; k++, i++) { const p = person(i); add(`${p.name}_zdjecie.jpg`, renderCv(p.lines, { type: 'image/jpeg' })); }
for (let k = 0; k < 3; k++, i++) { const p = person(i); add(`${p.name}_skan.pdf`, scannedPdf(p.lines)); }
// 5 duplicates of earlier candidates (same e-mail / phone), different file names
for (const d of [0, 1, 2, 4, 5]) { const p = person(d); add(`duplikat_${p.name}.pdf`, textPdf(['Życiorys', ...p.lines.slice(1)])); }
add('skan_nieczytelny_1.png', renderCv(person(50).lines, { noise: true }));
add('skan_nieczytelny_2.jpg', renderCv(person(51).lines, { noise: true, type: 'image/jpeg' }));
add('zabezpieczony.pdf', protectedPdf());
add('uszkodzony.pdf', Buffer.from('To nie jest PDF, tylko zwykły tekst z rozszerzeniem pdf.'));
add('stary_format.doc', Buffer.from('DOC binary placeholder'));
add('pusty.txt', 'CV');
add('pusta_strona.png', renderCv([], { blank: true }));
zip.file('__MACOSX/._ignore.pdf', 'x');
const out = process.argv[2] ?? 'bulk-cv-60.zip';
await writeFile(out, await zip.generateAsync({ type: 'nodebuffer' }));
console.log(`${n} files -> ${out}`);
