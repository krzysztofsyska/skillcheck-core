// SC-LEGAL-001: published legal documents (v1.0). Texts live in docs/legal/<version>/*.md and are
// rendered 1:1 by app/components/legal/legal-document.tsx. Do not edit wording here.

export const LEGAL_VERSION = '1.0';

/**
 * Effective/publication date shown in place of the "[DATA PUBLIKACJI]" marker.
 * Must be set by the owner before promotion to production (P24 verification).
 */
export const LEGAL_EFFECTIVE_DATE: string | null = "28 października 2026 r.";

export const COMPANY = {
  name: 'KTIG CONSULTING spółka z ograniczoną odpowiedzialnością',
  shortName: 'KTIG CONSULTING Sp. z o.o.',
  address: 'ul. Michała Kajki 10–12, 10-547 Olsztyn',
  krs: '0001110252',
  nip: '7394002294',
  regon: '528903093',
  shareCapital: '5 000 zł',
  email: 'pomoc@skillcheck.pl',
  phone: '+48 730 266 909',
  phoneHref: 'tel:+48730266909',
} as const;

export const LEGAL_DOCUMENTS = {
  regulamin: { file: '01_Regulamin_SkillCheck.md', docx: '/legal/01_Regulamin_SkillCheck_v1.0.docx', href: '/regulamin' },
  prywatnosc: { file: '02_Polityka_prywatnosci.md', docx: '/legal/02_Polityka_prywatnosci_v1.0.docx', href: '/polityka-prywatnosci' },
  dpa: { file: '03_Umowa_powierzenia_DPA.md', docx: '/legal/03_Umowa_powierzenia_DPA_v1.0.docx', href: '/regulamin/umowa-powierzenia' },
  odstapienie: { file: '04_Formularz_odstapienia.md', docx: '/legal/04_Formularz_odstapienia_v1.0.docx', href: '/regulamin/formularz-odstapienia' },
  ai: { file: '05_AI_i_nadzor_czlowieka.md', docx: '/legal/05_AI_i_nadzor_czlowieka_v1.0.docx', href: '/ai' },
} as const;
export type LegalDocumentKey = keyof typeof LEGAL_DOCUMENTS;

/** Registration form field and the only accepted value. */
export const LEGAL_ACCEPTANCE_FIELD = 'legal_acceptance';
export const LEGAL_ACCEPTANCE_VALUE = `v${LEGAL_VERSION}`;

export function hasLegalAcceptance(form: FormData): boolean {
  return form.get(LEGAL_ACCEPTANCE_FIELD) === LEGAL_ACCEPTANCE_VALUE;
}

// ---------------------------------------------------------------------------
// Minimal Markdown parser for the controlled legal texts (no HTML passthrough).

export type Inline = { kind: 'text' | 'strong' | 'em'; text: string };
export type Block =
  | { kind: 'heading'; level: 1 | 2; text: Inline[] }
  | { kind: 'paragraph'; text: Inline[] }
  | { kind: 'ordered' | 'bullets'; items: { text: Inline[]; sub: Inline[][] }[] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };
export type LegalDoc = { title: string; blocks: Block[] };

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: source.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: 'strong', text: m[1] } : { kind: 'em', text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ kind: 'text', text: source.slice(last) });
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => parseInline(c.trim()));

export function parseLegalMarkdown(markdown: string, effectiveDate: string | null = LEGAL_EFFECTIVE_DATE): LegalDoc {
  let text = markdown.replace(/\r\n/g, '\n');
  if (effectiveDate) {
    // "…od [DATA PUBLIKACJI]." + a date ending in "r." must not produce "r..".
    if (effectiveDate.endsWith('.')) text = text.replaceAll('[DATA PUBLIKACJI].', effectiveDate);
    text = text.replaceAll('[DATA PUBLIKACJI]', effectiveDate);
  }
  let title = '';
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (front) {
    title = /^title:\s*(.+)$/m.exec(front[1])?.[1].trim() ?? '';
    text = text.slice(front[0].length);
  }
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2, text: parseInline(heading[2]) }); i++; continue; }
    if (line.startsWith('|')) {
      const header = cells(line);
      i += 2; // header + separator
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const listMatch = /^(\d+\.|-)\s+/.exec(line);
    if (listMatch) {
      const kind = listMatch[1] === '-' ? 'bullets' : 'ordered';
      const items: { text: Inline[]; sub: Inline[][] }[] = [];
      while (i < lines.length) {
        const item = /^(\d+\.|-)\s+(.*)$/.exec(lines[i]);
        if (item && (item[1] === '-') === (kind === 'bullets')) { items.push({ text: parseInline(item[2]), sub: [] }); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].sub.push(parseInline(lines[i].trim())); i++; continue; }
        break;
      }
      blocks.push({ kind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,2}\s|\||\d+\.\s|-\s)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push({ kind: 'paragraph', text: parseInline(para.join(' ')) });
  }
  return { title, blocks };
}
