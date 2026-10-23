import Link from "next/link";
import styles from "../../marketing.module.css";
import { sc19OfferScopes, type Sc19PackageSizes } from "../../../lib/sc19-package-sizes";

export function PackageComparison({ sizes }: { sizes: Sc19PackageSizes | null }) {
  const offer = sc19OfferScopes(sizes);
  const plans = [
    {name:"FREE", color:styles.planBlue, title:"Wypróbuj SkillCheck", text:"Poznaj docelowy proces na niewielkiej grupie kandydatów.", price:"0 zł", scope:offer.freeScope, features:["Konto firmy i profil stanowiska", "Pseudonimizacja i ocena dopasowania", "Chatbot informacyjny dla kandydatów", "Podstawowa shortlista", "Jedna próbna rozmowa z botem i podstawowa analiza"]},
    {name:"PRESELEKCJA", color:styles.planGreen, title:"Uporządkuj wybór kandydatów", text:"Porównaj materiały z wymaganiami stanowiska i przygotuj shortlistę.", price:"Po wycenie", scope:offer.preselectionScope, features:["Konto firmy i profil stanowiska", "Pseudonimizacja i ocena dopasowania", "Chatbot informacyjny dla kandydatów", "Shortlista — zakres ustalany w ofercie", "Podstawowy raport preselekcji"]},
    {name:"WERYFIKACJA", color:styles.planPurple, title:"Sprawdź, co naprawdę potrafią", text:"Pogłęb ocenę przez rozmowę, jej analizę i test kompetencji.", price:"899 zł", scope:"20 rozmów + testy; analizy CV według zatwierdzonej polityki", features:["Wszystko z Preselekcji", "20 rozmów weryfikacyjnych z botem", "Analiza odpowiedzi z rozmowy", "Testy kompetencji", "Rozszerzony raport kandydata"]},
    {name:"ASSESSMENT CENTER", color:styles.planOrange, title:"Zobacz, jak podejdą do pracy", text:"Sprawdź sposób działania w zadaniach osadzonych w realiach stanowiska.", price:"1 799 zł", scope:"20 rozmów + testy + case studies; analizy CV według zatwierdzonej polityki", features:["Wszystko z Weryfikacji", "Case studies i zadania praktyczne", "Ćwiczenia dopasowane do roli", "Pogłębiony proces Assessment Center", "Kompleksowy raport kandydata"]},
  ];
  const rows = [
    ["Konto firmy i profil stanowiska","Tak","Tak","Tak","Tak"],
    ["Analizy CV", offer.freeAnalyses, offer.preselectionAnalyses, "Według polityki", "Według polityki"],
    ["Pseudonimizacja i ocena dopasowania","Tak","Tak","Tak","Tak"],
    ["Chatbot informacyjny","Tak","Tak","Tak","Tak"],
    ["Shortlista / raport preselekcji","Podstawowe","Według oferty","5–10 kandydatów","5–10 kandydatów"],
    ["Rozmowa weryfikacyjna z botem","1 próbna","Nie","20","20"],
    ["Analiza rozmowy","Podstawowa","Nie","Tak","Tak"],
    ["Test kompetencji","Nie","Nie","Tak","Tak"],
    ["Case studies i zadania praktyczne","Nie","Nie","Nie","Tak"],
    ["Pełny Assessment Center","Nie","Nie","Nie","Tak"],
    ["Raport kandydata","Podstawowy","Podstawowy","Rozszerzony","Kompleksowy"],
    ["Talent Pool za zgodą kandydata","Planowany","Planowany","Planowany","Planowany"],
  ];
  return <>
  <div className={styles.packageCards}>{plans.map(plan=><article key={plan.name} className={`${styles.planCard} ${plan.color}`}>
    <p className={styles.planLabel}>Planowany pakiet</p><h3>{plan.name}</h3><p className={styles.planTitle}>{plan.title}</p><p>{plan.text}</p>
    <ul>{plan.features.map(f=><li key={f}>{f}</li>)}</ul>
    <div className={styles.planPrice}><strong>{plan.price}</strong><p>{plan.scope}</p><small>Cena robocza z wizualizacji</small></div>
    <Link href={plan.name === "FREE" ? "/preselekcja#free" : plan.name === "PRESELEKCJA" ? "/preselekcja" : "/rozmowa"} className={styles.secondary}>Zapytaj o {plan.name === "FREE" ? "wariant próbny" : plan.name}</Link>
  </article>)}</div>
  <p className={styles.note}>{sizes
    ? "Liczby analiz CV dla FREE i PRESELEKCJA pochodzą z zatwierdzonej polityki pakietu. To nadal nie jest aktywny cennik. Ceny i warunki wymagają zatwierdzenia przed sprzedażą. Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”."
    : "To koncepcja oferty do oceny, nie aktywny cennik. Ceny, limity i warunki wymagają zatwierdzenia przed sprzedażą. Liczba analiz CV jest pokazywana dopiero z zatwierdzonej polityki pakietu. Założenie konta nie aktywuje pakietu. Aktualną dostępność funkcji pokazujemy w sekcji „Jak to działa”."}</p>
  <details className={styles.packageDetails}><summary>Porównaj wszystkie funkcje pakietów</summary>
    <div className={styles.tableScroll} role="region" aria-label="Porównanie pakietów — przewijaj poziomo na telefonie" tabIndex={0}><table className={styles.packageTable}><caption>Docelowy zakres pakietów — funkcje planowane</caption><thead><tr><th scope="col">Co otrzymujesz?</th>{plans.map(p=><th scope="col" key={p.name} className={p.color}>{p.name}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row[0]}><th scope="row">{row[0]}</th>{row.slice(1).map((v,i)=><td key={i}>{v}</td>)}</tr>)}</tbody></table></div>
  </details>
  <div className={styles.subscription}><div><p className={styles.kicker}>Kierunek rozwoju</p><h3>Abonament dla firm rekrutujących regularnie</h3><p>Planujemy elastyczne pule analiz, rozmów i testów do wykorzystania na różne stanowiska. Warunki kumulacji jednostek i oferta dla większych organizacji będą ustalane przed uruchomieniem.</p></div><Link href="/rozmowa" className={styles.secondary}>Porozmawiajmy o potrzebach firmy</Link></div>
</>;
}
