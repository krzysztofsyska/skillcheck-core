import type { ExerciseDefinition } from './exercise-definition.ts';
import type { AcStageType } from './assessment-center-session.ts';

/**
 * SC-AC-SESSION (#276): one seedable, fully SYNTHETIC case for an HR Business Partner.
 * The company, the numbers and the people are invented for tests and Preview only.
 * Three case-study stages (causes → financial consequences → change) and one
 * simulation with a human. Every rubric is human-authored; nothing here scores,
 * ranks or recommends a candidate.
 */
export type AcSessionTemplateStage = { type: AcStageType; title: string; counterpartBrief: string | null; definition: ExerciseDefinition };
export type AcSessionTemplate = { title: string; plannedCompetencies: string[]; stages: AcSessionTemplateStage[] };

const stage = (type: AcStageType, title: string, instructions: string, expectedOutput: string, durationMinutes: number,
  criteria: ExerciseDefinition['criteria'], counterpartBrief: string | null = null): AcSessionTemplateStage => ({
  type, title, counterpartBrief,
  definition: { kind: 'assessment_center', title, instructions, expectedOutput, durationMinutes, criteria },
});

export const hrbpCaseTemplate: AcSessionTemplate = {
  title: 'Assessment Center HRBP — rotacja w centrum logistycznym (dane syntetyczne)',
  plannedCompetencies: ['Diagnoza przyczyn', 'Myślenie finansowe', 'Planowanie zmiany', 'Komunikacja z biznesem'],
  stages: [
    stage('case_study', 'Etap 1 — diagnoza przyczyn rotacji',
      'Fikcyjna spółka „Magazyn Północ” (dane syntetyczne) zatrudnia 240 osób. W ciągu 12 miesięcy rotacja na zmianie nocnej wzrosła z 18% do 41%. Na podstawie załączonych danych o absencji, wynikach ankiety i wywiadach wyjściowych wskaż przyczyny i oddziel je od objawów.',
      'Lista przyczyn z dowodami z danych oraz lista hipotez, których dane nie potwierdzają.', 45,
      [{ competency: 'Diagnoza przyczyn', below: 'Opisuje objawy i przyjmuje pierwszą hipotezę bez sprawdzenia danych',
        meets: 'Oddziela przyczyny od objawów i wskazuje dane, które je potwierdzają',
        above: 'Sprawdza hipotezy alternatywne i nazywa dane, których brakuje do pewnego wniosku' }]),
    stage('case_study', 'Etap 2 — konsekwencje finansowe',
      'Policz roczny koszt obecnej rotacji dla spółki „Magazyn Północ” (dane syntetyczne): rekrutacja, wdrożenie, nadgodziny i utracona wydajność. Pokaż założenia.',
      'Szacunek kosztu w złotych z jawnymi założeniami i zakresem niepewności.', 40,
      [{ competency: 'Myślenie finansowe', below: 'Podaje kwotę bez założeń albo pomija główne składniki kosztu',
        meets: 'Liczy koszt z jawnymi założeniami dla głównych składników',
        above: 'Pokazuje wrażliwość wyniku na założenia i wskazuje, który składnik decyduje o kwocie' }]),
    stage('case_study', 'Etap 3 — plan zmiany',
      'Zaproponuj plan zmiany na 6 miesięcy dla spółki „Magazyn Północ” (dane syntetyczne): działania, właściciele, mierniki i ryzyka. Plan ma wynikać z diagnozy i z policzonego kosztu.',
      'Plan działań z miernikami, właścicielami i kolejnością oraz opisem ryzyk.', 45,
      [{ competency: 'Planowanie zmiany', below: 'Wymienia działania bez mierników i bez związku z diagnozą',
        meets: 'Łączy działania z przyczynami, nadaje im właścicieli i mierniki',
        above: 'Ustala kolejność według wpływu i kosztu oraz planuje, jak sprawdzić skuteczność po 3 miesiącach' },
      { competency: 'Myślenie finansowe', below: 'Nie odnosi kosztu planu do kosztu rotacji',
        meets: 'Porównuje koszt planu z policzonym kosztem rotacji',
        above: 'Wskazuje próg opłacalności i moment, w którym plan należy przerwać' }]),
    stage('human_simulation', 'Etap 4 — rozmowa z dyrektorem operacyjnym',
      'Przedstaw wnioski i plan dyrektorowi operacyjnemu, który uważa, że problemem są wyłącznie stawki. Rozmowa trwa 20 minut.',
      'Uzgodnione kolejne kroki albo jasno nazwana różnica zdań i sposób jej rozstrzygnięcia.', 20,
      [{ competency: 'Komunikacja z biznesem', below: 'Wykłada plan bez pytań i ustępuje albo naciska przy pierwszym sprzeciwie',
        meets: 'Dopytuje o stanowisko rozmówcy i odpowiada na nie danymi',
        above: 'Doprowadza do wspólnego kolejnego kroku i nazywa to, co pozostaje sporne' },
      { competency: 'Planowanie zmiany', below: 'Nie potrafi wskazać pierwszego kroku planu',
        meets: 'Wskazuje pierwszy krok i jego miernik',
        above: 'Dostosowuje kolejność kroków do ograniczeń przedstawionych przez rozmówcę' }],
      'Rolę dyrektora operacyjnego gra przeszkolona osoba z zespołu rekrutującego (nie asesor). Trzyma się scenariusza: sceptyczny, pyta o koszty, przerywa po 10 minutach.'),
  ],
};
