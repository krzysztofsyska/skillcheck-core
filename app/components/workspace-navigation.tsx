"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { BUY_PRESELEKCJA_LABEL, workspacePurchasePath } from "../../lib/buy-preselekcja";
import styles from "./workspace-navigation.module.css";

export function WorkspaceNavigation() {
  const params = useParams();
  const companyId = params?.companyId;
  const recruitmentId = params?.recruitmentId;
  // Keep the originating recruitment on the checkout return path; the server
  // still verifies membership and ownership before authorizing a purchase.
  const purchasePath = workspacePurchasePath(companyId, recruitmentId);

  return <header className={styles.header}>
    <nav className={styles.navigation} aria-label="Nawigacja konta">
      <Link className={styles.brand} href="/">SkillCheck — strona główna</Link>
      <Link href="/#pakiety">Oferta i pakiety</Link>
      <Link href="/dashboard">Moje konto</Link>
      <Link className="button" href={purchasePath}>{BUY_PRESELEKCJA_LABEL}</Link>
    </nav>
  </header>;
}
