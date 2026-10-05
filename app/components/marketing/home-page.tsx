import Link from "next/link";
import styles from "../../marketing.module.css";
import { capabilities, faq, packages, steps, availabilityNote } from "./content";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

const statusClass = {
  Dostępne: styles.statusReady,
  "Częściowo dostępne": styles.statusPartial,
  "W przygotowaniu": styles.statusSoon,
  Planowane: styles.statusPlanned,
} as const;

export function HomePage() {
  return (
    <main className={styles.page}>
      <SiteHeader />
      <div id="tresc">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={`${styles.wrap} ${styles.heroGrid}`}>
            <div>
              <p className={styles.kicker}>Rekrutacja oparta na materiałach</p>
              <h1 id="hero-title">Uporządkuj ocenę kandydatów przed rozmową rekrutacyjną</h1>
              <p className={styles.lede}>
                SkillCheck zestawia informacje o kandydacie z wymaganiami stanowiska. Pokazuje, co wynika z dostarczonych materiałów, jakich informacji brakuje i jakie pytania warto zadać na rozmowie. Decyzję o kolejnym kroku podejmuje człowiek.
              </p>
              <div className={styles.actions}>
                <Link href="/demo" className={styles.primary}>Zobacz przykład</Link>
                <Link href="/register" className={styles.secondary}>Utwórz konto</Link>
              </div>
              <p className={styles.note}>
                Założenie konta nie uruchamia analizy i nie aktywuje pakietu. Część funkcji opisanych niżej jest jeszcze w przygotowaniu.
              </p>
            </div>
            <aside className={styles.preview} aria-label="Układ informacji w przykładzie">
              <p className={styles.previewKicker}>Układ informacji, nie wynik</p>
              <dl className={styles.previewList}>
                <div>
                  <dt>Wymaganie</dt>
                  <dd>Wspólne kryterium stanowiska.</dd>
                </div>
                <div>
                  <dt>Materiał</dt>
                  <dd>Cytat albo informacja, że danych nie ma.</dd>
                </div>
                <div>
                  <dt>Luka</dt>
                  <dd>Temat oznaczony jako brak danych lub do wyjaśnienia.</dd>
                </div>
                <div>
                  <dt>Rozmowa</dt>
                  <dd>Pytanie, które ma tę lukę uzupełnić.</dd>
                </div>
              </dl>
            </aside>
          </div>
        </section>

        <section className={styles.block} id="jak-to-dziala" aria-labelledby="jak-title">
          <div className={styles.wrap}>
            <h2 id="jak-title">Jak to działa</h2>
            <p className={styles.intro}>
              Docelowy przebieg prowadzi od wymagań stanowiska do rozmowy. Nie każda część jest już dostępna w aplikacji.
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

        <section className={styles.blockAlt} id="mozliwosci" aria-labelledby="cap-title">
          <div className={styles.wrap}>
            <h2 id="cap-title">Możliwości</h2>
            <p className={styles.intro}>
              Poniżej jest sens tych elementów. To nie jest obietnica skuteczności rekrutacji ani automatycznej bezstronności.
            </p>
            <div className={styles.grid}>
              {capabilities.map((item) => (
                <article key={item.title} className={styles.card}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.block} id="pakiety" aria-labelledby="pkg-title">
          <div className={styles.wrap}>
            <h2 id="pkg-title">Planowana oferta</h2>
            <p className={styles.intro}>
              Cztery kierunki oferty. To nie jest cennik i nie jest aktywny zakup. Cen, limitów, okresów próbnych i terminów dostępności nie podajemy, bo nie zostały zatwierdzone.
            </p>
            <div className={styles.grid}>
              {packages.map((item) => (
                <article key={item.name} className={styles.card}>
                  <p className={`${styles.status} ${styles.statusPlanned}`}>Planowane</p>
                  <h3 className={styles.packageName}>{item.name}</h3>
                  <p className={styles.packageTitle}>{item.title}</p>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
            <p className={styles.note}>
              Rozmowa głosowa z kandydatem i pomiar jakości zatrudnienia pozostają w planach rozwoju. Nie są dostępne na tej stronie.
            </p>
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
            <div className={styles.closing}>
              <h2>Zobacz układ informacji albo załóż konto</h2>
              <p>
                Przykład jest fikcyjny. Konto daje dostęp do funkcji oznaczonych jako dostępne. Nie włącza analizy ani pakietu.
              </p>
              <div className={styles.actions}>
                <Link href="/demo" className={styles.primary}>Zobacz przykład</Link>
                <Link href="/register" className={styles.secondary}>Utwórz konto</Link>
              </div>
            </div>
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
