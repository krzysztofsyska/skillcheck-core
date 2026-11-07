import { FutureOfferPreview } from "./future-offer-preview";
import Link from "next/link";
import styles from "../../marketing.module.css";
import { sc19AnalysisScope, sc19PolicyPendingCell, sc19PolicyPendingScope, type Sc19PackageSizes } from "../../../lib/sc19-package-sizes";
import { freeAnalyses, freePrice, preselekcjaAnalyses, preselekcjaOffer, preselekcjaPrice } from "./preselekcja-offer";
import { futureOffers } from "./future-offers";
import { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH } from "../../../lib/buy-preselekcja";

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
    {plan.name === "FREE"
      ? <Link href="/preselekcja#free" className={styles.secondary}>{`Wypróbuj FREE — ${freePrice}`}</Link>
      : <><Link href={BUY_PRESELEKCJA_PATH} className={styles.primary}>{BUY_PRESELEKCJA_LABEL}</Link>
        <Link href="/preselekcja" className={styles.secondary}>Poznaj szczegóły oferty</Link></>}
  </article>)}</div>
  <p className={styles.note}>{sizes
    ? `${preselectionNote} Liczba analiz CV pochodzi z zatwierdzonej polityki pakietów. Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”.`
    : `${preselectionNote} Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”.`}</p>
  <details className={styles.packageDetails}><summary>Porównaj FREE i PRESELEKCJĘ</summary>
    <div className={styles.tableScroll} role="region" aria-label="Porównanie pakietów — przewijaj poziomo na telefonie" tabIndex={0}><table className={styles.packageTable}><caption>Zakres pakietów dostępnych dzisiaj</caption><thead><tr><th scope="col">Co otrzymujesz?</th>{plans.map(p=><th scope="col" key={p.name} className={p.color}>{p.name}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row[0]}><th scope="row">{row[0]}</th>{row.slice(1).map((v,i)=><td key={i}>{v}</td>)}</tr>)}</tbody></table></div>
  </details>
  <div id="planowane-pakiety" className={styles.futureIntro}>
    <h3>CV to początek. Zaplanuj kolejny krok.</h3>
    <p>WERYFIKACJA i ASSESSMENT CENTER są w przygotowaniu. Poniżej przedstawiamy planowany zakres, nie dostępne dziś funkcje pakietów. Nie można ich jeszcze kupić; nie podajemy terminu uruchomienia. Ostateczne warunki będą dostępne przed zakupem.</p>
    <p>Zacznij od dostępnej PRESELEKCJI. Gdy potrzebujesz głębszej oceny, zobacz, co przygotowujemy dla Twojego zespołu.</p>
  </div>
  <FutureOfferPreview />
  <div className={styles.futureGrid}>{futureOffers.map(stage=><article key={stage.name} className={styles.futureCard}>
    <p className={`${styles.status} ${styles.statusPlanned}`}>Cena zatwierdzona · pakiet w przygotowaniu</p>
    <h3>{stage.name}</h3><p className={styles.planTitle}>{stage.outcome}</p>
    <div className={styles.planPrice}><strong>{stage.price}</strong><p>{stage.scope}</p></div>
    <h4>Co planujemy w tej cenie?</h4>
    <ul>{stage.features.map(feature=><li key={feature}>{feature}</li>)}</ul>
    <h4>Kto wykonuje pracę?</h4>
    <p><strong>SkillCheck: </strong>{stage.system}</p>
    <p><strong>Twój zespół: </strong>{stage.client}</p>
    <p><strong>Czas uczestnika: </strong>{stage.effort}</p>
    {stage.exercises.length > 0 && <><h4>Ćwiczenia w pakiecie</h4><ol>{stage.exercises.map(exercise=><li key={exercise}>{exercise}</li>)}</ol></>}
    <details className={styles.packageDetails}>
      <summary>Raport i warunki planowanego pakietu</summary>
      <p>{stage.result}</p>
      <p>Jedno stanowisko, 3 miesiące od aktywacji. Jedno podejście do testu na osobę. Ponowienie z powodu potwierdzonego problemu technicznego nie zużywa kolejnego miejsca; poprawa wyniku nie jest wliczona.</p>
      <p>Cena obejmuje narzędzia i materiały. Nie obejmuje zewnętrznego asesora, pozyskania kandydatów ani organizacji sesji przez SkillCheck.</p>
    </details>
    <Link href="/rozmowa" className={styles.secondary}>{stage.name === "WERYFIKACJA" ? "Zapytaj o plan Weryfikacji" : "Zapytaj o plan Assessment Center"}</Link>
    <p className={styles.note}>Zapytanie nie jest zakupem ani rezerwacją. Termin uruchomienia nie został ustalony.</p>
  </article>)}</div>
  <div className={styles.futureIntro}>
    <h3>Co musi powstać przed uruchomieniem?</h3>
    <ol>
      <li><strong>Test i dostęp kandydata:</strong> przygotowanie i zatwierdzenie wspólnego zestawu, limity uczestników oraz obsługa podejść.</li>
      <li><strong>Ocena oparta na dowodach:</strong> arkusze rekrutera, trzy ćwiczenia AC i niezależne obserwacje dwóch oceniających.</li>
      <li><strong>Kompletne raporty:</strong> połączenie wyników, porównanie kandydatów oraz sprawdzenie całej ścieżki przed udostępnieniem sprzedaży.</li>
    </ol>
    <p>To plan rozwoju. Poszczególne elementy mogą być przygotowane wcześniej, ale cały pakiet udostępnimy dopiero po sprawdzeniu procesu od początku do końca.</p>
  </div>
</>;
}
