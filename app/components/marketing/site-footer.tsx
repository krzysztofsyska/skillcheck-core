import Link from "next/link";
import styles from "../../marketing.module.css";
import { footerLinks } from "./links";

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
      </div>
    </footer>
  );
}
