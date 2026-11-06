"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH } from "../../lib/buy-preselekcja";
import styles from "./workspace-navigation.module.css";

export function WorkspaceNavigation() {
  const params = useParams();
  const companyId = params?.companyId;
  // Keep purchases in the company currently being viewed. The checkout page
  // continues to verify membership and ownership on the server.
  const purchasePath = typeof companyId === "string"
    ? `/dashboard/${encodeURIComponent(companyId)}/billing/checkout`
    : BUY_PRESELEKCJA_PATH;

  return <header className={styles.header}>
    <nav className={styles.navigation} aria-label="Nawigacja konta">
      <Link className={styles.brand} href="/">SkillCheck — strona główna</Link>
      <Link href="/#pakiety">Oferta i pakiety</Link>
      <Link href="/dashboard">Moje konto</Link>
      <Link className="button" href={purchasePath}>{BUY_PRESELEKCJA_LABEL}</Link>
    </nav>
  </header>;
}
