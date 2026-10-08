import Link from "next/link";
import styles from "../../marketing.module.css";
import { sectionLinks } from "./links";
import { MobileNav } from "./mobile-nav";

const mobileLinks = [
  ...sectionLinks,
  { href: "/login", label: "Zaloguj się" },
  { href: "/rozmowa", label: "Porozmawiajmy o Twojej rekrutacji" },
  { href: "/demo", label: "Zobacz przykład", variant: "primary" as const },
];

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <a className={styles.skip} href="#tresc">Przejdź do treści</a>
      <div className={styles.wrap}>
        <div className={styles.headerRow}>
          <Link href="/" className={styles.brand}>SkillCheck</Link>
          <nav className={styles.desktopNav} aria-label="Główne">
            {sectionLinks.map((link) => (
              <Link key={link.href} href={link.href} className={styles.navLink}>
                {link.label}
              </Link>
            ))}
            <Link href="/login" className={styles.loginLink}>Zaloguj się</Link>
            <Link href="/rozmowa" className={styles.navLink}>Porozmawiajmy o Twojej rekrutacji</Link>
            <Link href="/demo" className={styles.primary}>Zobacz przykład</Link>
          </nav>
          <MobileNav links={mobileLinks} />
        </div>
      </div>
    </header>
  );
}
