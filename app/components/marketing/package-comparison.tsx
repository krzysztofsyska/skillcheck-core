import Link from "next/link";
import styles from "../../marketing.module.css";
import { sc19AnalysisScope, sc19PolicyPendingCell, sc19PolicyPendingScope, type Sc19PackageSizes } from "../../../lib/sc19-package-sizes";
import { freeAnalyses, freePrice, preselekcjaAnalyses, preselekcjaOffer, preselekcjaPrice } from "./preselekcja-offer";
import { nextStages, nextStagesNote } from "./content";

export function PackageComparison({ sizes, catalogEnabled = false }: { sizes: Sc19PackageSizes | null; catalogEnabled?: boolean }) {
  // Live catalog wins when enabled; an enabled but failing catalog shows no number.
  // With the catalog off, the owner-approved FREE and PRESELEKCJA offers are shown.
  const analyses = preselekcjaAnalyses(catalogEnabled, sizes);
  const free = freeAnalyses(catalogEnabled, sizes);
  const preselectionCount = analyses === null ? null : sc19AnalysisScope(analyses);
  const freeCount = free === null ? null : sc19AnalysisScope(free);
  const validity = `ważne ${preselekcjaOffer.validityMonths} miesiące`;
  const preselectionNote = preselectionCount
    ? `PRESELEKCJA: ${preselectionCount} za ${preselekcjaPrice}, ${validity} od przyznania.`
    : `PRESELEKCJA: ${preselekcjaPrice}, ${validity} od przyznania.`;
  const plans = [
    {name:"FREE", color:styles.planBlue, title:free === null ? "Analiza CV na próbę" : `Analiza ${free} CV`, text:"Sprawdź sposób porządkowania informacji na własnych CV, zanim wybierzesz większy zakres.", price:freePrice, scope:freeCount ?? sc19PolicyPendingScope, features:["Konto firmy i profil stanowiska", "Pseudonimizacja i analiza CV przez AI", "Dowody, braki i pytania na rozmowę", "Ranking i raport preselekcji", "Rejestracja: NIP i firmowy e-mail, jeden pakiet na firmę"]},
    {name:"PRESELEKCJA", color:styles.planGreen, title:analyses === null ? "Analiza CV, shortlista i raport" : `Analiza ${analyses} CV, shortlista i raport`, text:"Porównaj materiały z wymaganiami stanowiska i przygotuj shortlistę do dalszej oceny.", price:preselekcjaPrice, scope:`${preselectionCount ?? sc19PolicyPendingScope} · ${validity}`, features:["Konto firmy i profil stanowiska", "Pseudonimizacja i analiza CV przez AI", "Dowody, braki i pytania na rozmowę", "Ranking, shortlista i raport z eksportem", "Płatność przelewem na fakturę proforma"]},
  ];
  const rows = [
    ["Konto firmy i profil stanowiska","Tak","Tak"],
    ["Analizy CV", free === null ? sc19PolicyPendingCell : String(free), analyses === null ? sc19PolicyPendingCell : String(analyses)],
    ["Pseudonimizacja i analiza CV przez AI","Tak","Tak"],
    ["Dowody, braki i pytania na rozmowę","Tak","Tak"],
    ["Shortlista / raport preselekcji","Podstawowe","Według oferty"],
    ["Eksport raportu","Tak","Tak"],
    ["Cena",freePrice,preselekcjaPrice],
  ];
  return <>
  <div className={styles.packageCards}>{plans.map(plan=><article key={plan.name} className={`${styles.planCard} ${plan.color}`}>
    <h3>{plan.name}</h3><p className={styles.planTitle}>{plan.title}</p><p>{plan.text}</p>
    <ul>{plan.features.map(f=><li key={f}>{f}</li>)}</ul>
    <div className={styles.planPrice}><strong>{plan.price}</strong><p>{plan.scope}</p></div>
    <Link href={plan.name === "FREE" ? "/preselekcja#free" : "/preselekcja"} className={plan.name === "FREE" ? styles.secondary : styles.primary}>{plan.name === "FREE" ? `Wypróbuj FREE — ${freePrice}` : "Zamów PRESELEKCJĘ"}</Link>
  </article>)}</div>
  <p className={styles.note}>{sizes
    ? `${preselectionNote} Liczba analiz CV pochodzi z zatwierdzonej polityki pakietów. Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”.`
    : `${preselectionNote} Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”.`}</p>
  <details className={styles.packageDetails}><summary>Porównaj FREE i PRESELEKCJĘ</summary>
    <div className={styles.tableScroll} role="region" aria-label="Porównanie pakietów — przewijaj poziomo na telefonie" tabIndex={0}><table className={styles.packageTable}><caption>Zakres pakietów dostępnych dzisiaj</caption><thead><tr><th scope="col">Co otrzymujesz?</th>{plans.map(p=><th scope="col" key={p.name} className={p.color}>{p.name}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row[0]}><th scope="row">{row[0]}</th>{row.slice(1).map((v,i)=><td key={i}>{v}</td>)}</tr>)}</tbody></table></div>
  </details>
  <div className={styles.grid}>{nextStages.map(stage=><article key={stage.name} className={styles.card}>
    <p className={styles.planLabel}>Kolejny etap</p><h3>{stage.name}</h3><p className={styles.planTitle}>{stage.title}</p><p>{stage.body}</p>
    <div className={styles.planPrice}><strong>{stage.price}</strong><p>{stage.scope}</p></div>
    <p className={`${styles.status} ${styles.statusPlanned}`}>Cena zatwierdzona · pakiet w przygotowaniu</p>
  </article>)}</div>
  <p className={styles.note}>{nextStagesNote} <Link href="/rozmowa">Napisz, jeśli chcesz o nich porozmawiać.</Link></p>
</>;
}
