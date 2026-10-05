import Link from "next/link";
import marketing from "../../marketing.module.css";
import styles from "../../demo/demo.module.css";
import { candidates, criteria, demoNotice, labelHelp, role, type EvidenceLabel } from "./demo-data";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

const chipClass: Record<EvidenceLabel, string> = {
  "Informacja w materiale": styles.chipInfo,
  "Częściowa informacja": styles.chipPartial,
  "Brak danych": styles.chipMissing,
  "Do wyjaśnienia": styles.chipOpen,
};

export function DemoPage() {
  return (
    <main className={marketing.page}>
      <SiteHeader />
      <div id="tresc">
        <section className={marketing.hero} aria-labelledby="demo-title">
          <div className={marketing.wrap}>
            <p className={styles.banner} role="note">
              <strong>{demoNotice}</strong>
            </p>
            <h1 id="demo-title">Rekrutacja przedstawiciela handlowego</h1>
            <p className={marketing.lede}>
              Ta prezentacja nie jest wynikiem analizy wykonanej dla użytkownika. Profile, cytaty i porównanie są wymyślone, żeby pokazać układ informacji. Nazwy firm i osób są fikcyjne.
            </p>
            <p className={marketing.note}>
              Nie pokazujemy procentowego dopasowania. Brak danych nie jest zamieniany na ocenę zero. Nie wskazujemy, kogo zatrudnić ani kogo odrzucić.
            </p>
            <div className={marketing.actions}>
              <Link href="/" className={marketing.secondary}>Wróć do oferty</Link>
              <Link href="/register" className={marketing.primary}>Utwórz konto</Link>
            </div>
          </div>
        </section>

        <section className={marketing.block} aria-labelledby="role-title">
          <div className={marketing.wrap}>
            <h2 id="role-title">Stanowisko i wymagania</h2>
            <p className={styles.roleTitle}>{role.title}</p>
            <p className={marketing.intro}>{role.description}</p>
            <ul className={styles.requirementList}>
              {criteria.map((criterion) => (
                <li key={criterion.id}>
                  <strong>{criterion.title}.</strong> {criterion.expectation}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className={marketing.blockAlt} aria-labelledby="profiles-title">
          <div className={marketing.wrap}>
            <h2 id="profiles-title">Trzy fikcyjne profile</h2>
            <p className={marketing.intro}>
              Kolejność jest alfabetyczna według nazwiska. Nie jest rankingiem i nie oznacza rekomendacji.
            </p>
            <div className={styles.profiles}>
              {candidates.map((candidate) => (
                <div key={candidate.name} className={styles.profile}>
                  <h3>{candidate.name}</h3>
                  <p>{candidate.profile}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={marketing.block} aria-labelledby="compare-title">
          <div className={marketing.wrap}>
            <h2 id="compare-title">Porównanie informacji względem wspólnych kryteriów</h2>
            <p className={marketing.intro}>
              Każda osoba jest opisana tymi samymi czterema kryteriami. Oznaczenie mówi, co da się wyczytać z fikcyjnych materiałów.
            </p>
            <dl className={styles.legend}>
              {(Object.keys(labelHelp) as EvidenceLabel[]).map((label) => (
                <div key={label}>
                  <dt className={`${styles.chip} ${chipClass[label]}`}>{label}</dt>
                  <dd>{labelHelp[label]}</dd>
                </div>
              ))}
            </dl>
            <div className={styles.matrix}>
              {criteria.map((criterion) => (
                <div key={criterion.id} className={styles.criterion}>
                  <h3 id={`criterion-${criterion.id}`}>{criterion.title}</h3>
                  <div className={styles.cells}>
                    {candidates.map((candidate) => {
                      const finding = candidate.findings[criterion.id];
                      return (
                        <div key={candidate.name} className={styles.cell}>
                          <h4>{candidate.name}</h4>
                          <p className={`${styles.chip} ${chipClass[finding.label]}`}>{finding.label}</p>
                          <p>{finding.summary}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={marketing.blockAlt} aria-labelledby="evidence-title">
          <div className={marketing.wrap}>
            <h2 id="evidence-title">Przykładowe dowody z fikcyjnych materiałów</h2>
            <p className={marketing.intro}>
              Każdy cytat pochodzi z wymyślonego CV, listu, opinii albo notatki. Cytat z oznaczeniem „Brak danych” lub „Do wyjaśnienia” nie potwierdza kryterium. Pokazuje tylko wzmiankę, która w materiale jest.
            </p>
            <div className={styles.stack}>
              {candidates.map((candidate) => (
                <div key={candidate.name} className={styles.stackBlock}>
                  <h3>{candidate.name}</h3>
                  <ul className={styles.evidenceList}>
                    {criteria.map((criterion) => {
                      const finding = candidate.findings[criterion.id];
                      return (
                        <li key={criterion.id}>
                          <p className={styles.evidenceMeta}>
                            <span>{criterion.title}</span>
                            <span className={`${styles.chip} ${chipClass[finding.label]}`}>{finding.label}</span>
                          </p>
                          {finding.quote ? (
                            <blockquote className={styles.quote}>
                              <p>„{finding.quote.text}”</p>
                              <footer>{finding.quote.source}</footer>
                            </blockquote>
                          ) : (
                            <p>{finding.summary}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={marketing.block} aria-labelledby="gaps-title">
          <div className={marketing.wrap}>
            <h2 id="gaps-title">Brakujące informacje</h2>
            <p className={marketing.intro}>
              Lista zbiera tematy, których materiały nie rozstrzygają. Brak wpisu nie obniża wyniku, bo wyniku liczbowego tu nie ma.
            </p>
            <div className={styles.profiles}>
              {candidates.map((candidate) => (
                <div key={candidate.name} className={styles.profile}>
                  <h3>{candidate.name}</h3>
                  <ul className={styles.plainList}>
                    {candidate.gaps.map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={marketing.blockAlt} aria-labelledby="questions-title">
          <div className={marketing.wrap}>
            <h2 id="questions-title">Proponowane pytania do rozmowy</h2>
            <p className={marketing.intro}>
              Pytania mają uzupełnić to, czego materiały nie rozstrzygają. Nie są poleceniem zatrudnienia ani odrzucenia i nie opisują osobowości.
            </p>
            <div className={styles.stack}>
              {candidates.map((candidate) => (
                <div key={candidate.name} className={styles.stackBlock}>
                  <h3>{candidate.name}</h3>
                  <ol className={styles.plainList}>
                    {candidate.questions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
            <div className={marketing.closing}>
              <h2>To nadal jest przykład</h2>
              <p>
                Po założeniu konta można korzystać z funkcji już dostępnych w aplikacji. Rejestracja nie uruchamia analizy i nie aktywuje pakietu.
              </p>
              <div className={marketing.actions}>
                <Link href="/" className={marketing.secondary}>Wróć do oferty</Link>
                <Link href="/register" className={marketing.primary}>Utwórz konto</Link>
              </div>
            </div>
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
