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
              <p className={styles.kicker}>Ludzie. Kompetencje. Świadome decyzje.</p>
              <h1 id="hero-title">Podobne CV. Różni ludzie. Zupełnie inne wyniki w pracy.</h1>
              <p className={styles.lede}>
                Budujemy SkillCheck, aby pomóc firmom lepiej zrozumieć, kogo naprawdę potrzebują — i na jakich podstawach wybrać tę osobę. Łączymy wymagania stanowiska, materiały kandydatów i ustrukturyzowaną ocenę w jednym miejscu. Ostateczna decyzja należy do człowieka.
              </p>
              <div className={styles.actions}>
                <Link href="/demo" className={styles.primary}>Zobacz przykład</Link>
                <Link href="/rozmowa" className={styles.secondary}>Porozmawiajmy o Twojej rekrutacji</Link>
              </div>
              <p className={styles.note}>
                Produkt rozwijamy etapami. Zobacz przykład raportu i sprawdź poniżej, które funkcje są już dostępne.
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

        <section className={styles.blockAlt} id="dlaczego" aria-labelledby="problem-title">
          <div className={`${styles.wrap} ${styles.storyGrid}`}>
            <div><p className={styles.kicker}>Dlaczego powstaje SkillCheck</p><h2 id="problem-title">Za każdą decyzją o zatrudnieniu stoi coś więcej niż kolejny etat.</h2></div>
            <div><p className={styles.intro}>To czas menedżera, wysiłek zespołu i miesiące wdrożenia. To cele, które czekają na realizację. Gdy zatrudnienie okazuje się nietrafione, firma często wraca do punktu wyjścia.</p><p>Dwie osoby z podobnym doświadczeniem mogą zupełnie inaczej rozwiązywać problemy, podejmować decyzje i pracować samodzielnie. Dlatego warto wiedzieć, co rzeczywiście wynika z materiałów, a co wymaga sprawdzenia w rozmowie lub zadaniu.</p></div>
          </div>
        </section>
        <section className={styles.block} id="dla-kogo" aria-labelledby="audience-title">
          <div className={styles.wrap}><p className={styles.kicker}>Dla kogo</p><h2 id="audience-title">Dla firm, w których każde zatrudnienie ma znaczenie.</h2>
            <div className={styles.audienceGrid}>
              <article className={styles.card}><h3>Właściciele i menedżerowie</h3><p>Gdy sam prowadzisz rekrutację, potrzebujesz jasnych kryteriów i uporządkowanych informacji, do których możesz wrócić przed decyzją.</p></article>
              <article className={styles.card}><h3>Zespoły HR</h3><p>Gdy w procesie uczestniczy kilka osób, wspólny profil stanowiska i zapisane obserwacje pomagają rozmawiać o tych samych wymaganiach.</p></article>
              <article className={styles.card}><h3>Agencje rekrutacyjne</h3><p>Gdy pracujesz dla różnych organizacji, ważne jest zrozumienie konkretnego klienta. Rozwój SkillCheck obejmuje także przyszłe rozwiązania dla agencji.</p></article>
            </div>
          </div>
        </section>

        <section className={styles.block} id="jak-to-dziala" aria-labelledby="jak-title">
          <div className={styles.wrap}>
            <p className={styles.kicker}>Od potrzeb firmy do decyzji</p><h2 id="jak-title">Najpierw zrozumieć stanowisko. Potem oceniać kandydatów.</h2>
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

        <section className={styles.blockAlt} id="mozliwosci" aria-labelledby="cap-title">
          <div className={styles.wrap}>
            <h2 id="cap-title">Więcej podstaw do rozmowy. Jaśniejsze kryteria decyzji.</h2>
            <p className={styles.intro}>
              Projektujemy proces, w którym możesz wskazać źródło informacji, zauważyć brak danych i zaplanować kolejny krok weryfikacji.
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

        <section className={styles.future} id="kierunek" aria-labelledby="future-title">
          <div className={`${styles.wrap} ${styles.storyGrid}`}>
            <div><p className={styles.kicker}>Kierunek rozwoju · Quality of Hire</p><h2 id="future-title">Podpisanie umowy to początek odpowiedzi.</h2><span className={`${styles.status} ${styles.statusPlanned}`}>Planowane</span></div>
            <div><p className={styles.intro}>Chcemy połączyć to, co wiemy o kandydacie przed zatrudnieniem, z tym, jak radzi sobie później w rzeczywistej pracy.</p><p>Planowany moduł Quality of Hire ma zbierać krótkie oceny po 30 i 90 dniach, a opcjonalnie także po 180. Celem jest lepsze zrozumienie, które kryteria warto uwzględnić w kolejnej rekrutacji.</p><p className={styles.futureQuestion}>Czy zatrudniłbyś tę osobę ponownie?</p><p>To kierunek rozwoju produktu. Moduł nie jest jeszcze dostępny, a jego wartość wymaga potwierdzenia w praktyce.</p></div>
          </div>
        </section>

        <section className={styles.block} id="pakiety" aria-labelledby="pkg-title">
          <div className={styles.wrap}>
            <h2 id="pkg-title">Planowana oferta</h2>
            <p className={styles.intro}>
              Od pierwszego uporządkowania materiałów po pogłębioną ocenę kompetencji. Rozwijamy cztery poziomy oferty — pakiety nie są jeszcze dostępne w sprzedaży.
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

        <section className={styles.blockAlt} id="o-nas" aria-labelledby="about-title">
          <div className={`${styles.wrap} ${styles.storyGrid}`}><div><p className={styles.kicker}>O nas</p><h2 id="about-title">Budujemy technologię, która pomaga lepiej rozumieć ludzi w kontekście pracy.</h2></div><div><p>Za SkillCheck stoi KTIG CONSULTING Sp. z o.o. Rozwijamy platformę wspierającą firmy w porządkowaniu wymagań, materiałów i obserwacji rekrutacyjnych.</p><p>Naszym punktem odniesienia jest konkretna organizacja i rzeczywista praca na stanowisku. AI ma wspierać analizę; odpowiedzialność za decyzję pozostaje po stronie człowieka.</p><p>KTIG CONSULTING Sp. z o.o.<br />ul. Michała Kajki 10–12, 10-547 Olsztyn<br /><a href="mailto:pomoc@skillcheck.pl">pomoc@skillcheck.pl</a></p></div></div>
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
              <h2>Jakiego człowieka potrzebuje Twoja firma?</h2>
              <p>
                Zobacz fikcyjny przykład raportu lub opowiedz nam o stanowisku, które chcesz obsadzić. Zacznijmy od potrzeb Twojej organizacji.
              </p>
              <div className={styles.actions}>
                <Link href="/demo" className={styles.primary}>Zobacz przykład</Link>
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
