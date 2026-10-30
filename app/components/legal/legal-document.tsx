import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fragment } from "react";
import Link from "next/link";
import { SiteHeader } from "../marketing/site-header";
import { SiteFooter } from "../marketing/site-footer";
import marketing from "../../marketing.module.css";
import styles from "./legal.module.css";
import { LEGAL_DOCUMENTS, LEGAL_VERSION, parseLegalMarkdown, type Inline, type LegalDocumentKey } from "../../../lib/legal";

export function loadLegalDocument(key: LegalDocumentKey) {
  const source = readFileSync(join(process.cwd(), "docs", "legal", `v${LEGAL_VERSION}`, LEGAL_DOCUMENTS[key].file), "utf8");
  return parseLegalMarkdown(source);
}

function Text({ parts }: { parts: Inline[] }) {
  return <>{parts.map((p, i) => p.kind === "strong" ? <strong key={i}>{p.text}</strong> : p.kind === "em" ? <em key={i}>{p.text}</em> : <Fragment key={i}>{p.text}</Fragment>)}</>;
}

const related: { key: LegalDocumentKey; label: string }[] = [
  { key: "regulamin", label: "Regulamin" },
  { key: "dpa", label: "Załącznik nr 1 – Umowa powierzenia (DPA)" },
  { key: "odstapienie", label: "Załącznik nr 2 – Formularz odstąpienia" },
  { key: "prywatnosc", label: "Polityka prywatności" },
  { key: "ai", label: "AI i nadzór człowieka" },
  { key: "aneks1", label: "Aneks nr 1 – Rozmowy głosowe z asystentem AI" },
];

export function LegalDocumentPage({ documentKey }: { documentKey: LegalDocumentKey }) {
  const doc = loadLegalDocument(documentKey);
  return <main className={marketing.page}>
    <SiteHeader />
    <div id="tresc" className={styles.document}><article>
      <h1>{doc.title}</h1>
      {doc.blocks.map((b, i) => {
        if (b.kind === "heading") return <h2 key={i}><Text parts={b.text} /></h2>;
        if (b.kind === "paragraph") return <p key={i}><Text parts={b.text} /></p>;
        if (b.kind === "table") return <div key={i} className={styles.tableWrap}><table>
          <thead><tr>{b.header.map((c, j) => <th key={j} scope="col"><Text parts={c} /></th>)}</tr></thead>
          <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Text parts={c} /></td>)}</tr>)}</tbody>
        </table></div>;
        const items = b.items.map((it, j) => <li key={j}><Text parts={it.text} />
          {it.sub.length > 0 && <span className={styles.sub}>{it.sub.map((s, k) => <span key={k}><Text parts={s} /></span>)}</span>}</li>);
        return b.kind === "ordered" ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      })}
      <p className={styles.download}><a href={LEGAL_DOCUMENTS[documentKey].docx} download>Pobierz dokument (.docx)</a></p>
      <nav aria-label="Dokumenty prawne" className={styles.related}>
        <h2>Dokumenty SkillCheck</h2>
        <ul>{related.filter((r) => r.key !== documentKey).map((r) => <li key={r.key}><Link href={LEGAL_DOCUMENTS[r.key].href}>{r.label}</Link></li>)}</ul>
      </nav>
    </article></div>
    <SiteFooter />
  </main>;
}
