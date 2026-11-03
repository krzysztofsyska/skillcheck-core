import Link from "next/link";
import styles from "../../marketing.module.css";
import { loadSc19PackageSizes, loadSc19PublicOfferSizes } from "../../../lib/sc19-package-sizes";
import { createClient } from "../../../lib/supabase/server";
import { freeAnalyses, freePrice, isSc19CatalogEnabled, preselekcjaAnalyses, preselekcjaOffer, preselekcjaPrice } from "./preselekcja-offer";
import {
  assumptions,
  availabilityNote,
  benefits,
  capabilities,
  comparisonNote,
  faq,
  heroLede,
  heroTitle,
  sources,
  steps,
} from "./content";
import { PackageComparison } from "./package-comparison";
import { BUY_PRESELEKCJA_LABEL, BUY_PRESELEKCJA_PATH } from "../../../lib/buy-preselekcja";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

const statusClass = {
  Dostępne: styles.statusReady,
  "Częściowo dostępne": styles.statusPartial,
  "W przygotowaniu": styles.statusSoon,
  Planowane: styles.statusPlanned,
} as const;

export async function HomePage() {
  const catalogEnabled = isSc19CatalogEnabled();
  const sizes = await loadSc19PublicOfferSizes(
    catalogEnabled,
    async () => loadSc19PackageSizes(await createClient()),
  );
  const preselekcja = preselekcjaAnalyses(catalogEnabled, sizes);
  const free = freeAnalyses(catalogEnabled, sizes);
  return (
    <main className={styles.page}>
      <SiteHeader />
      <div id="tresc">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={`${styles.wrap} ${styles.heroGrid}`}>
            <div>
              <p className={styles.kicker}>Ludzie. Kompetencje. Świadome decyzje.</p>
              <h1 id="hero-title">{heroTitle}</h1>
              <p className={styles.lede}>{heroLede}</p>
              <div className={styles.actions}>
                <Link href={BUY_PRESELEKCJA_PATH} className={styles.primary}>{BUY_PRESELEKCJA_LABEL}</Link>
                <Link href="/preselekcja#free" className={styles.secondary}>{`Wypróbuj FREE — ${freePrice}`}</Link>
                <Link href="/kalkulator" className={styles.secondary}>Sprawdź koszt rekrutacji</Link>
              </div>
              <p className={styles.note}>
                {preselekcja ? `PRESELEKCJA: ${preselekcja} CV za ${preselekcjaPrice}.` : `PRESELEKCJA: ${preselekcjaPrice}.`} {free ? `FREE: bezpłatna analiza ${free} CV, jedna na firmę.` : "FREE: bezpłatna próba, jedna na firmę."} Ta strona niczego nie uruchamia i nie pobiera płatności.
              </p>
            </div>
            <aside className={styles.visionCard} aria-label="Pytanie, od którego zaczynamy">
              <p className={styles.previewKicker}>Zacznijmy od właściwego pytania</p>
              <blockquote>Co musi wydarzyć się po sześciu miesiącach, żeby uznać zatrudnienie tej osoby za sukces?</blockquote>
              <p>Od tej odpowiedzi zaczyna się profil stanowiska. Dopiero później przychodzi czas na CV.</p>
              <div className={styles.signalRow}><span>Firma</span><span>Stanowisko</span><span>Kryteria sukcesu</span></div>
            </aside>
          </div>
        </section>

        <section className={styles.block} id="korzysci" aria-labelledby="benefits-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Co z tego masz</p>
            <h2 id="benefits-title">Cztery powody, dla których warto sprawdzić kandydatów przed rozmową.</h2>
            <div className={styles.grid}>
              {benefits.map((item) => (
                <article key={item.title} className={styles.card}>
                  <h3>{item.title}</h3>
                  <p className={styles.planTitle}>{item.claim}</p>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.blockAlt} id="dlaczego" aria-labelledby="problem-title">
          <div className={`${styles.wrap} ${styles.storyGrid}`}>
            <div>
              <p className={styles.kicker}>Dlaczego samo CV nie wystarcza</p>
              <h2 id="problem-title">Podobne CV. Różni ludzie. Zupełnie inne wyniki w pracy.</h2>
              <p className={styles.futureQuestion}>CV pokazuje deklaracje. Sprawdź więcej.</p>
            </div>
            <div>
              <p className={styles.intro}>Dwie osoby z podobnym doświadczeniem mogą zupełnie inaczej rozwiązywać problemy, podejmować decyzje i pracować samodzielnie. Z dokumentu nie wynika, które z zapisanych doświadczeń odpowiadają wymaganiom Twojego stanowiska.</p>
              <p>Za każdą decyzją o zatrudnieniu stoi czas menedżera, wysiłek zespołu i miesiące wdrożenia. Dlatego warto wiedzieć, co rzeczywiście wynika z materiałów, a co wymaga sprawdzenia w rozmowie lub zadaniu.</p>
            </div>
          </div>
        </section>

        <section className={styles.block} id="jak-to-dziala" aria-labelledby="jak-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Jak działa SkillCheck</p><h2 id="jak-title">Najpierw zrozumieć stanowisko. Potem oceniać kandydatów.</h2>
            <p className={styles.intro}>
              Zakres odpowiedzialności, oczekiwane rezultaty, samodzielność i trudne sytuacje tworzą kontekst oceny. W tym kontekście materiały kandydata nabierają znaczenia.
            </p>
            <p className={styles.note}>{availabilityNote}</p>
            <ol className={styles.steps}>
              {steps.map((step) => (
                <li key={step.number} className={styles.card}>
                  <p className={styles.stepNumber}>Krok {step.number}</p>
                  <h3>{step.title}</h3>
                  <p className={`${styles.status} ${statusClass[step.status]}`}>{step.status}</p>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.blockAlt} id="przyklad" aria-labelledby="example-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Przykładowy raport</p>
            <h2 id="example-title">Zobacz, jak wygląda wynik, zanim cokolwiek zamówisz.</h2>
            <p className={styles.intro}>
              Fikcyjny przykład dla stanowiska przedstawiciela handlowego pokazuje układ informacji: wymagania, dowody z materiałów, braki danych i pytania na rozmowę.
            </p>
            <div className={styles.grid}>
              {capabilities.map((item) => (
                <article key={item.title} className={styles.card}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
            <div className={styles.actions}>
              <Link href="/demo" className={styles.primary}>Zobacz przykładowy raport</Link>
            </div>
          </div>
        </section>

        <section className={styles.block} id="kalkulator" aria-labelledby="calc-title">
          <div className={`${styles.wrap} ${styles.storyGrid}`}>
            <div>
              <p className={styles.kicker}>Kalkulator czasu i kosztu</p>
              <h2 id="calc-title">Własne CV. Mniej pracy powtarzalnej.</h2>
            </div>
            <div>
              <p className={styles.intro}>Policz, ile czasu zajmuje ręczne przeczytanie Twojej puli CV i ile kosztuje ten czas. Wpisujesz własną liczbę CV, czas na jeden dokument i koszt godziny pracy.</p>
              <p>Przy przykładowych założeniach — 50 CV, 6 minut na dokument i 65 zł za godzinę — ręczna analiza to około 5 godzin i 325 zł netto kosztu pracy. To koszt Twojego procesu przy podanych założeniach, a nie gwarantowana oszczędność dzięki SkillCheck.</p>
              <div className={styles.actions}>
                <Link href="/kalkulator" className={styles.primary}>Sprawdź koszt rekrutacji</Link>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.block} id="pakiety" aria-labelledby="pkg-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Wybierz zakres</p>
            <h2 id="pkg-title">Nie płać za większy zakres, niż potrzebujesz.</h2>
            <p className={styles.intro}>Dziś kupisz FREE i PRESELEKCJĘ. FREE jest opcjonalnym pierwszym krokiem, a nie warunkiem zakupu PRESELEKCJI.</p>
            <PackageComparison sizes={sizes} catalogEnabled={catalogEnabled} />
          </div>
        </section>

        <section className={styles.blockAlt} id="agencja" aria-labelledby="agency-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Porównanie z agencją</p>
            <h2 id="agency-title">Masz już kandydatów? Porównaj budżety.</h2>
            <p className={styles.intro}>
              Przykładowy scenariusz dla jednego stanowiska, w kwotach netto: pełna usługa agencji za 10 000 zł wobec PRESELEKCJI za {preselekcjaOffer.netPln} zł powiększonej o 1 500 zł własnych kosztów klienta. Różnica budżetów w tym scenariuszu to około 8 256 zł.
            </p>
            <p className={styles.note}>{comparisonNote}</p>
            <div className={styles.actions}>
              <Link href="/kalkulator" className={styles.secondary}>Zmień założenia w kalkulatorze</Link>
            </div>
          </div>
        </section>

        <section className={styles.block} id="zalozenia" aria-labelledby="assumptions-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Założenia i źródła</p>
            <h2 id="assumptions-title">Wiesz, skąd bierze się każda kwota.</h2>
            <p className={styles.intro}>Wszystkie parametry są jawne i edytowalne w kalkulatorze. Ceny FREE i PRESELEKCJI są aktualne; porównanie z agencją jest symulacją budżetów.</p>
            <div className={styles.grid}>
              {assumptions.map((item) => (
                <article key={item.label} className={styles.card}>
                  <h3>{item.label}</h3>
                  <p className={styles.planTitle}>{item.value}</p>
                  <p>{item.note}</p>
                </article>
              ))}
            </div>
            <ul>
              {sources.map((source) => (
                <li key={source.href}>
                  <a href={source.href} target="_blank" rel="noopener noreferrer">{source.label}</a>{" — "}{source.note}
                </li>
              ))}
            </ul>
            <p className={styles.note}>Są to przykłady konkretnych ofert, a nie średnie rynkowe. Warunki każdej agencji potwierdza się indywidualnie.</p>
          </div>
        </section>

        <section className={styles.blockAlt} id="faq" aria-labelledby="faq-title">
          <div className={styles.wrap}>
            <h2 id="faq-title">FAQ</h2>
            <div className={styles.faqList}>
              {faq.map((item) => (
                <div key={item.question} className={styles.faqItem}>
                  <h3>{item.question}</h3>
                  <p>{item.answer}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.block} id="o-nas" aria-labelledby="about-title">
          <div className={`${styles.wrap} ${styles.storyGrid}`}><div><p className={styles.kicker}>O nas</p><h2 id="about-title">Budujemy technologię, która pomaga lepiej rozumieć ludzi w kontekście pracy.</h2></div><div><p>Za SkillCheck stoi KTIG CONSULTING Sp. z o.o. Rozwijamy platformę wspierającą firmy w porządkowaniu wymagań, materiałów i obserwacji rekrutacyjnych.</p><p>Naszym punktem odniesienia jest konkretna organizacja i rzeczywista praca na stanowisku. AI ma wspierać analizę; odpowiedzialność za decyzję pozostaje po stronie człowieka.</p><p>KTIG CONSULTING Sp. z o.o.<br />ul. Michała Kajki 10–12, 10-547 Olsztyn<br /><a href="mailto:pomoc@skillcheck.pl">pomoc@skillcheck.pl</a></p></div></div>
        </section>

        <section className={styles.blockAlt} id="zgloszenie" aria-labelledby="closing-title">
          <div className={styles.wrap}>
            <div className={styles.closing}>
              <p className={styles.kicker}>Najpierw sprawdź. Potem zdecyduj.</p>
              <h2 id="closing-title">Pierwszy krok do lepiej uporządkowanej rekrutacji.</h2>
              <p>
                Zgłoś firmę do bezpłatnej próby albo zamów PRESELEKCJĘ. Do rejestracji potrzebny jest numer NIP i firmowy adres e-mail.
              </p>
              <div className={styles.actions}>
                <Link href="/preselekcja#free" className={styles.primary}>{`Wypróbuj FREE — ${freePrice}`}</Link>
                <Link href="/preselekcja" className={styles.secondary}>Zamów PRESELEKCJĘ</Link>
                <Link href="/rozmowa" className={styles.secondary}>Porozmawiajmy o Twojej rekrutacji</Link>
              </div>
            </div>
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
