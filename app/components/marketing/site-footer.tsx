import Link from "next/link";
import styles from "../../marketing.module.css";
import { footerLinks, legalLinks } from "./links";
import { COMPANY } from "../../../lib/legal";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.wrap}>
        <Link href="/" className={styles.footerBrand}>SkillCheck</Link>
        <p className={styles.footerNote}>
          Informacje o kandydatach zestawione z wymaganiami stanowiska. Decyzję podejmuje człowiek.
        </p>
        <nav className={styles.footerNav} aria-label="Stopka">
          {footerLinks.map((link) => (
            <Link key={link.href} href={link.href}>{link.label}</Link>
          ))}
        </nav>
        <nav className={styles.footerNav} aria-label="Dokumenty prawne">
          {legalLinks.map((link) => (
            <Link key={link.href} href={link.href}>{link.label}</Link>
          ))}
        </nav>
        <address className={styles.footerCompany}>
          {`${COMPANY.shortName}, ${COMPANY.address}`}<br />
          {`KRS ${COMPANY.krs} · NIP ${COMPANY.nip} · REGON ${COMPANY.regon} · kapitał zakładowy ${COMPANY.shareCapital}`}<br />
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>{" · "}<a href={COMPANY.phoneHref}>{COMPANY.phone}</a>
        </address>
      </div>
    </footer>
  );
}
