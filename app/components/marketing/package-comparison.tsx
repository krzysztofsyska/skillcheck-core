import Link from "next/link";
import styles from "../../marketing.module.css";
import { sc19OfferScopes, sc19PolicyPendingCell, sc19PolicyPendingScope, type Sc19PackageSizes } from "../../../lib/sc19-package-sizes";
import { preselekcjaAnalyses, preselekcjaOffer, preselekcjaPrice } from "./preselekcja-offer";

export function PackageComparison({ sizes, catalogEnabled = false }: { sizes: Sc19PackageSizes | null; catalogEnabled?: boolean }) {
  const offer = sc19OfferScopes(sizes);
  // Live catalog wins when enabled; an enabled but failing catalog shows no number.
  // With the catalog off, the owner-approved PRESELEKCJA offer is shown.
  const analyses = preselekcjaAnalyses(catalogEnabled, sizes);
  const preselectionCount = analyses === null ? null : `${analyses} analiz CV`;
  const validity = `ważne ${preselekcjaOffer.validityMonths} miesiące`;
  const preselectionNote = preselectionCount
    ? `PRESELEKCJA: ${preselectionCount} za ${preselekcjaPrice}, ${validity} od przyznania.`
    : `PRESELEKCJA: ${preselekcjaPrice}, ${validity} od przyznania.`;
  const plans: { name:string; color:string; title:string; text:string; price:string; scope:string; current?:boolean; priceApproved?:boolean; features:string[] }[] = [
    {name:"FREE", color:styles.planBlue, title:"Wypróbuj SkillCheck", text:"Poznaj docelowy proces na niewielkiej grupie kandydatów.", price:"0 zł", scope:offer.freeScope, current:true, features:["Konto firmy i profil stanowiska", "Pseudonimizacja i analiza CV przez AI", "Dowody, braki i pytania na rozmowę", "Ranking i raport preselekcji", "Jeden pakiet na firmę (weryfikacja NIP)"]},
    {name:"PRESELEKCJA", color:styles.planGreen, title:"Uporządkuj wybór kandydatów", text:"Porównaj materiały z wymaganiami stanowiska i przygotuj shortlistę.", price:preselekcjaPrice, current:true, scope:`${preselectionCount ?? sc19PolicyPendingScope} · ${validity}`, features:["Konto firmy i profil stanowiska", "Pseudonimizacja i analiza CV przez AI", "Dowody, braki i pytania na rozmowę", "Ranking, shortlista i raport z eksportem", "Płatność na podstawie faktury"]},
    {name:"WERYFIKACJA", color:styles.planPurple, title:"Sprawdź, co naprawdę potrafią", text:"Pogłęb ocenę testem kompetencji i rozszerzonym raportem.", price:"615 zł", priceApproved:true, scope:"60 analiz CV + testy kompetencji; pula CV zwiększana co 5", features:["Wszystko z Preselekcji", "Testy kompetencji", "Rozszerzony raport kandydata", "Zadania układane z profilu stanowiska", "Rozmowy z botem — w przygotowaniu"]},
    {name:"ASSESSMENT CENTER", color:styles.planOrange, title:"Zobacz, jak podejdą do pracy", text:"Sprawdź sposób działania w zadaniach osadzonych w realiach stanowiska.", price:"1 499 zł", priceApproved:true, scope:"50 analiz CV + testy + zadania praktyczne; proces dla 5–6 osób, maksymalnie 10", features:["Wszystko z Weryfikacji", "Case studies i zadania praktyczne", "Ćwiczenia dopasowane do roli", "Pogłębiony proces dla 5–6 finalistów", "Kompleksowy raport kandydata"]},
  ];
  const rows = [
    ["Konto firmy i profil stanowiska","Tak","Tak","Tak","Tak"],
    ["Analizy CV", offer.freeAnalyses, analyses === null ? sc19PolicyPendingCell : String(analyses), "60", "50"],
    ["Pseudonimizacja i analiza CV przez AI","Tak","Tak","Tak","Tak"],
    ["Shortlista / raport preselekcji","Podstawowe","Według oferty","5–10 kandydatów","5–10 kandydatów"],
    ["Rozmowy z botem (docelowo)","1 próbna","10","10","10"],
    ["Analiza rozmowy (docelowo)","Podstawowa","Podstawowa","Pogłębiona","Pogłębiona"],
    ["Test kompetencji","Nie","Nie","Tak","Tak"],
    ["Case studies i zadania praktyczne","Nie","Nie","Nie","Tak (5–6 osób)"],
    ["Pełny Assessment Center","Nie","Nie","Nie","Tak"],
    ["Raport kandydata","Raport preselekcji","Raport preselekcji","Rozszerzony","Kompleksowy"],
    ["Talent Pool za zgodą kandydata","Planowany","Planowany","Planowany","Planowany"],
  ];
  return <>
  <div className={styles.packageCards}>{plans.map(plan=><article key={plan.name} className={`${styles.planCard} ${plan.color}`}>
    {!plan.current && <p className={styles.planLabel}>Planowany pakiet</p>}<h3>{plan.name}</h3><p className={styles.planTitle}>{plan.title}</p><p>{plan.text}</p>
    <ul>{plan.features.map(f=><li key={f}>{f}</li>)}</ul>
    <div className={styles.planPrice}><strong>{plan.price}</strong><p>{plan.scope}</p>{!plan.current && <small>{plan.priceApproved ? "Cena zatwierdzona · pakiet w przygotowaniu" : "Cena robocza z wizualizacji"}</small>}</div>
    <Link href={plan.name === "FREE" ? "/preselekcja#free" : plan.name === "PRESELEKCJA" ? "/preselekcja" : "/rozmowa"} className={styles.secondary}>{plan.name === "FREE" ? "Jak uzyskać FREE" : `Zapytaj o ${plan.name}`}</Link>
  </article>)}</div>
  <p className={styles.note}>{sizes
    ? `${preselectionNote} Liczba analiz CV dla FREE pochodzi z zatwierdzonej polityki pakietu. Ceny pozostałych pakietów są zatwierdzone (WERYFIKACJA 615 zł brutto za 60 CV, ASSESSMENT CENTER 1 499 zł brutto za 50 CV); ich zakres i dostępność potwierdzamy przed sprzedażą. Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”.`
    : `${preselectionNote} Ceny pozostałych pakietów są zatwierdzone (WERYFIKACJA 615 zł brutto za 60 CV, ASSESSMENT CENTER 1 499 zł brutto za 50 CV); ich limity, zakres i dostępność potwierdzamy przed sprzedażą. Liczba analiz CV dla FREE jest pokazywana dopiero z zatwierdzonej polityki pakietu. Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”.`}</p>
  <details className={styles.packageDetails}><summary>Porównaj wszystkie funkcje pakietów</summary>
    <div className={styles.tableScroll} role="region" aria-label="Porównanie pakietów — przewijaj poziomo na telefonie" tabIndex={0}><table className={styles.packageTable}><caption>Docelowy zakres pakietów. Rozmowy z botem i ich analiza są w przygotowaniu i nie są jeszcze dostępne w żadnym pakiecie.</caption><thead><tr><th scope="col">Co otrzymujesz?</th>{plans.map(p=><th scope="col" key={p.name} className={p.color}>{p.name}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row[0]}><th scope="row">{row[0]}</th>{row.slice(1).map((v,i)=><td key={i}>{v}</td>)}</tr>)}</tbody></table></div>
  </details>
  <div className={styles.subscription}><div><p className={styles.kicker}>Kierunek rozwoju</p><h3>Abonament dla firm rekrutujących regularnie</h3><p>Planujemy elastyczne pule analiz, rozmów i testów do wykorzystania na różne stanowiska. Warunki kumulacji jednostek i oferta dla większych organizacji będą ustalane przed uruchomieniem.</p></div><Link href="/rozmowa" className={styles.secondary}>Porozmawiajmy o potrzebach firmy</Link></div>
</>;
}
