// SC-METHOD / #275 — profil metody stanowiska i macierz dowodów.
// Kontrakt: docs/sc-method-275.md. Czyste funkcje, bez bazy i bez wywołań AI:
//  * proposeMethodProfile() — deterministyczna propozycja dla poziomu
//    odpowiedzialności, którą rekruter poprawia przed zatwierdzeniem;
//  * parseMethodProfileForm() / parseMethodProfileContent() — postać kanoniczna;
//  * methodProfileProblems() — czego brakuje do zatwierdzenia.
// Te same reguły egzekwuje baza (method.normalize_content w
// 20261112100000_sc_method_profile.sql); baza jest ostateczną granicą.
// Moduł nie ocenia kandydatów i nie podejmuje żadnej decyzji rekrutacyjnej.

export const responsibilityLevels = ['specialist', 'manager', 'director'] as const;
export type ResponsibilityLevel = (typeof responsibilityLevels)[number];
export const responsibilityLevelLabels: Record<ResponsibilityLevel, string> = {
  specialist: 'Specjalista', manager: 'Menedżer', director: 'Dyrektor',
};
export const responsibilityLevelHints: Record<ResponsibilityLevel, string> = {
  specialist: 'Odpowiada za jakość i terminowość własnej pracy.',
  manager: 'Odpowiada za wynik zespołu i rozwój ludzi.',
  director: 'Odpowiada za strategię, budżet i wynik całego obszaru.',
};

export const assessmentMethods = ['cv_evidence', 'competency_test', 'case_study', 'simulation', 'interview'] as const;
export type AssessmentMethod = (typeof assessmentMethods)[number];
export const assessmentMethodLabels: Record<AssessmentMethod, string> = {
  cv_evidence: 'Dowody w CV',
  competency_test: 'Test kompetencji (próbka pracy)',
  case_study: 'Studium przypadku',
  simulation: 'Symulacja sytuacji z pracy',
  interview: 'Rozmowa ustrukturyzowana',
};

export const METHOD_LIMITS = {
  profileText: 1000, competency: 500, rowText: 600, criterion: 300, criteriaPerRow: 8, rows: 30,
} as const;

export type EvidenceRow = {
  competency: string; evidence: string; method: AssessmentMethod | '';
  justification: string; criteria: string[]; limits: string;
};
export type MethodProfileContent = {
  goal: string; expectedOutcome: string; constraints: string;
  responsibilityLevel: ResponsibilityLevel | ''; matrix: EvidenceRow[];
};
export type MethodPosition = {
  title: string; description: string | null; tasks: readonly string[]; kpis: readonly string[];
  autonomy_level: number | null; required_competencies: readonly string[];
};

export const isResponsibilityLevel = (value: unknown): value is ResponsibilityLevel =>
  typeof value === 'string' && (responsibilityLevels as readonly string[]).includes(value);
export const isAssessmentMethod = (value: unknown): value is AssessmentMethod =>
  typeof value === 'string' && (assessmentMethods as readonly string[]).includes(value);

/**
 * Przycięcie białych znaków z obu końców: dokładnie ten sam zestaw co
 * method.trim_ws() w bazie (spacja, tabulator, nowa linia, CR, FF, VT, twarda
 * spacja). Porównanie kompetencji musi dawać ten sam wynik po obu stronach.
 */
export const trimWs = (text: string) => text.replace(/^[ \t\n\r\f\v\u00a0]+|[ \t\n\r\f\v\u00a0]+$/g, '');
/** Klucz porównania kompetencji: bez białych znaków na końcach, bez wielkości liter. */
export const competencyKey = (text: string) => trimWs(text).toLowerCase();
const key = competencyKey;
/** Kompetencje stanowiska bez pustych wierszy i powtórzeń, w kolejności z profilu. */
export function positionCompetencies(position: Pick<MethodPosition, 'required_competencies'>): string[] {
  const seen = new Set<string>();
  return position.required_competencies.map(trimWs).filter(item => {
    if (!item || seen.has(key(item))) return false;
    seen.add(key(item));
    return true;
  });
}

// --- deterministyczna propozycja -------------------------------------------

const formalPattern = /prawo jazdy|certyfikat|uprawnieni|licencj|wykształceni|dyplom|kurs\b|szkoleni|badani|książeczk/i;
const peoplePattern = /zesp|ludź|ludzi|komunik|feedback|informacj\w* zwrotn|deleg|motyw|konflikt|negocj|współprac|przywódz|lider|klient/i;

function proposedMethod(level: ResponsibilityLevel, competency: string): AssessmentMethod {
  // Formalne uprawnienie potwierdza dokument, nie zadanie — niezależnie od poziomu.
  if (formalPattern.test(competency)) return 'cv_evidence';
  if (level === 'specialist') return peoplePattern.test(competency) ? 'simulation' : 'competency_test';
  if (level === 'manager') return peoplePattern.test(competency) ? 'simulation' : 'case_study';
  return peoplePattern.test(competency) ? 'interview' : 'case_study';
}

const methodJustification: Record<AssessmentMethod, Record<ResponsibilityLevel, string>> = {
  cv_evidence: {
    specialist: 'To wymaganie formalne: potwierdza je dokument lub wpis w CV, a nie zadanie praktyczne.',
    manager: 'To wymaganie formalne: potwierdza je dokument lub wpis w CV, a nie zadanie praktyczne.',
    director: 'To wymaganie formalne: potwierdza je dokument lub wpis w CV, a nie zadanie praktyczne.',
  },
  competency_test: {
    specialist: 'Specjalista odpowiada za własne wykonanie, więc najwięcej mówi próbka pracy na typowym zadaniu ze stanowiska.',
    manager: 'Próbka pracy pokazuje, czy menedżer rozumie pracę zespołu, którą ma organizować.',
    director: 'Próbka pracy pokazuje sposób analizy problemu przed decyzją na poziomie obszaru.',
  },
  case_study: {
    specialist: 'Studium przypadku pokazuje sposób rozwiązywania nietypowego problemu w zakresie własnych zadań.',
    manager: 'Menedżer osiąga wynik przez zespół: studium przypadku pokazuje, jak planuje pracę, dzieli zadania i sprawdza rezultat.',
    director: 'Dyrektor decyduje o kierunku i pieniądzach: studium przypadku pokazuje, jak łączy strategię, budżet i skutki dla innych działów.',
  },
  simulation: {
    specialist: 'Symulacja pokazuje zachowanie w rozmowie z klientem lub współpracownikiem, czego nie widać w pisemnym zadaniu.',
    manager: 'Kierowanie ludźmi widać w działaniu: symulacja rozmowy z pracownikiem pokazuje delegowanie i informację zwrotną.',
    director: 'Symulacja spotkania pokazuje, jak dyrektor uzgadnia decyzję z innymi działami i zarządem.',
  },
  interview: {
    specialist: 'Rozmowa oparta na przykładach z doświadczenia uzupełnia to, czego nie da się sprawdzić zadaniem.',
    manager: 'Rozmowa oparta na przykładach pokazuje, jak kandydat prowadził zespół w podobnych sytuacjach.',
    director: 'Na tym poziomie liczą się decyzje z przeszłości i ich skutki: rozmowa oparta na przykładach pozwala je sprawdzić.',
  },
};

const methodLimits: Record<AssessmentMethod, string> = {
  cv_evidence: 'CV pokazuje deklarację kandydata, nie poziom umiejętności. Dokument trzeba potwierdzić przed zatrudnieniem.',
  competency_test: 'Wynik dotyczy jednego zadania w ograniczonym czasie. Nie przesądza o pracy w dłuższym okresie ani w innych warunkach.',
  case_study: 'Kandydat opisuje, co by zrobił, a nie to, co zrobił. Wniosek dotyczy sposobu myślenia, nie potwierdzonych wyników.',
  simulation: 'Symulacja jest krótka i umowna. Pokazuje zachowanie w jednej sytuacji, nie stały styl pracy.',
  interview: 'Rozmowa opiera się na relacji kandydata. Przykłady warto potwierdzić w referencjach.',
};
const noDecisionNote = 'To materiał do decyzji rekrutera, nie automatyczna decyzja o zatrudnieniu.';

const proposedEvidence: Record<ResponsibilityLevel, (competency: string) => string> = {
  specialist: c => `Przykład samodzielnie wykonanego zadania, w którym potrzebna była kompetencja „${c}”, z opisem własnego wkładu i rezultatu.`,
  manager: c => `Przykład wyniku osiągniętego przez zespół kandydata w obszarze „${c}”: wielkość zespołu, podział zadań i rezultat.`,
  director: c => `Przykład decyzji na poziomie firmy lub obszaru w zakresie „${c}”: cel, budżet, skutki finansowe i wpływ na inne działy.`,
};

const proposedCriteria: Record<ResponsibilityLevel, (competency: string) => string[]> = {
  specialist: c => [
    `Samodzielnie i poprawnie wykonuje własne zadania wymagające kompetencji „${c}”.`,
    'Wynik własnej pracy spełnia ustalony standard jakości i termin bez poprawek przełożonego.',
    'Rozpoznaje, kiedy problem wykracza poza jego zakres, i zgłasza go zamiast działać na własną rękę.',
  ],
  manager: c => [
    `Przekłada kompetencję „${c}” na wynik zespołu, a nie tylko własny.`,
    'Deleguje zadania: ustala cel, termin i sposób sprawdzenia rezultatu.',
    'Udziela informacji zwrotnej opartej na faktach i reaguje na słabszy wynik członka zespołu.',
  ],
  director: c => [
    `Wiąże kompetencję „${c}” ze strategią i celami całej firmy.`,
    'Podejmuje decyzje z uwzględnieniem budżetu i odpowiedzialności za wynik finansowy (P&L).',
    'Ocenia wpływ decyzji na inne działy i uzgadnia ją z nimi przed wdrożeniem.',
  ],
};

const autonomyNote = (autonomy: number | null) => autonomy ? ` (samodzielność ${autonomy}/5)` : '';
const proposedConstraints: Record<ResponsibilityLevel, (autonomy: number | null) => string> = {
  specialist: a => `Działa w ramach ustalonych zasad i własnego zakresu zadań${autonomyNote(a)}. Decyzje poza tym zakresem uzgadnia z przełożonym. Nie odpowiada za budżet ani za pracę innych osób.`,
  manager: a => `Odpowiada za wynik zespołu w ramach przyznanych ludzi i środków${autonomyNote(a)}. Decyzje kadrowe i wydatki ponad ustalony limit uzgadnia z przełożonym.`,
  director: a => `Odpowiada za budżet i wynik całego obszaru${autonomyNote(a)}. Ograniczają go strategia firmy, budżet roczny i decyzje zarządu.`,
};

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const listed = (items: readonly string[]) => items.map(trimWs).filter(Boolean).join('; ');

export type MethodProposal = { content: MethodProfileContent; missing: ('competencies')[] };

/**
 * Propozycja profilu metody dla wybranego poziomu odpowiedzialności. Ta sama
 * pozycja i ten sam poziom dają zawsze ten sam wynik (bez AI, bez losowości).
 * Kryteria różnią się między poziomami: specjalista — jakość własnej pracy;
 * menedżer — wynik zespołu, delegowanie, informacja zwrotna; dyrektor —
 * strategia, budżet/P&L, wpływ na inne działy.
 */
export function proposeMethodProfile(position: MethodPosition, level: ResponsibilityLevel): MethodProposal {
  const competencies = positionCompetencies(position).slice(0, METHOD_LIMITS.rows);
  const description = trimWs(position.description ?? '');
  const tasks = listed(position.tasks), kpis = listed(position.kpis);
  const goal = description || (tasks ? `Stanowisko „${trimWs(position.title)}” istnieje po to, aby: ${tasks}.` : '');
  const matrix = competencies.map(competency => {
    const short = clip(competency, 120);
    const method = proposedMethod(level, competency);
    return {
      competency,
      evidence: clip(proposedEvidence[level](short), METHOD_LIMITS.rowText),
      method,
      justification: methodJustification[method][level],
      criteria: proposedCriteria[level](short).map(item => clip(item, METHOD_LIMITS.criterion)),
      limits: `${methodLimits[method]} ${noDecisionNote}`,
    };
  });
  return {
    content: {
      goal: clip(goal, METHOD_LIMITS.profileText),
      expectedOutcome: clip(kpis, METHOD_LIMITS.profileText),
      constraints: proposedConstraints[level](position.autonomy_level),
      responsibilityLevel: level,
      matrix,
    },
    missing: competencies.length ? [] : ['competencies'],
  };
}

// --- postać kanoniczna i walidacja -----------------------------------------

const controlChars = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function cleanText(value: unknown, max: number, label: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`Pole „${label}” ma niepoprawną treść.`);
  const text = trimWs(value);
  if (controlChars.test(text)) throw new Error(`Pole „${label}” ma niepoprawną treść.`);
  // Baza liczy znaki, TypeScript jednostki UTF-16: ten limit bywa minimalnie ostrzejszy.
  if (text.length > max) throw new Error(`Skróć pole „${label}” do ${max} znaków.`);
  return text;
}

/** Sprawdza kształt i limity, przycina teksty. Puste pola są dozwolone (szkic). */
export function parseMethodProfileContent(value: unknown): MethodProfileContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Nie rozpoznano treści profilu metody.');
  const input = value as Record<string, unknown>;
  const level = cleanText(input.responsibilityLevel, 20, 'Poziom odpowiedzialności');
  if (level !== '' && !isResponsibilityLevel(level)) throw new Error('Wybierz poziom odpowiedzialności: specjalista, menedżer albo dyrektor.');
  const rawMatrix = input.matrix ?? [];
  if (!Array.isArray(rawMatrix) || rawMatrix.length > METHOD_LIMITS.rows) throw new Error(`Macierz dowodów może mieć najwyżej ${METHOD_LIMITS.rows} kompetencji.`);
  const seen = new Set<string>();
  const matrix = rawMatrix.map((raw): EvidenceRow => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Nie rozpoznano wiersza macierzy dowodów.');
    const row = raw as Record<string, unknown>;
    const competency = cleanText(row.competency, METHOD_LIMITS.competency, 'Kompetencja');
    if (!competency) throw new Error('Każdy wiersz macierzy musi wskazywać kompetencję.');
    if (seen.has(key(competency))) throw new Error(`Kompetencja „${competency}” występuje w macierzy więcej niż raz.`);
    seen.add(key(competency));
    const method = cleanText(row.method, 30, 'Metoda');
    if (method !== '' && !isAssessmentMethod(method)) throw new Error(`Wybierz metodę oceny dla kompetencji „${competency}”.`);
    const rawCriteria = row.criteria ?? [];
    if (!Array.isArray(rawCriteria) || rawCriteria.length > METHOD_LIMITS.criteriaPerRow) {
      throw new Error(`Kompetencja „${competency}” może mieć najwyżej ${METHOD_LIMITS.criteriaPerRow} kryteriów.`);
    }
    return {
      competency,
      evidence: cleanText(row.evidence, METHOD_LIMITS.rowText, 'Oczekiwany dowód'),
      method: method as AssessmentMethod | '',
      justification: cleanText(row.justification, METHOD_LIMITS.rowText, 'Uzasadnienie metody'),
      criteria: rawCriteria.map(item => cleanText(item, METHOD_LIMITS.criterion, 'Kryterium')).filter(Boolean),
      limits: cleanText(row.limits, METHOD_LIMITS.rowText, 'Granice wniosku'),
    };
  });
  return {
    goal: cleanText(input.goal, METHOD_LIMITS.profileText, 'Cel stanowiska'),
    expectedOutcome: cleanText(input.expectedOutcome, METHOD_LIMITS.profileText, 'Oczekiwany wynik'),
    constraints: cleanText(input.constraints, METHOD_LIMITS.profileText, 'Ograniczenia'),
    responsibilityLevel: level as ResponsibilityLevel | '',
    matrix,
  };
}

/** Formularz panelu -> treść. Wiersze macierzy mają pola `matrix.<n>.<pole>`. */
export function parseMethodProfileForm(form: FormData): MethodProfileContent {
  const text = (name: string) => { const value = form.get(name); return typeof value === 'string' ? value : ''; };
  const count = Number(text('rows'));
  if (!Number.isInteger(count) || count < 0 || count > METHOD_LIMITS.rows) throw new Error('Odśwież stronę, aby wczytać aktualną macierz dowodów.');
  return parseMethodProfileContent({
    goal: text('goal'), expectedOutcome: text('expectedOutcome'), constraints: text('constraints'),
    responsibilityLevel: text('responsibilityLevel'),
    matrix: Array.from({ length: count }, (_, index) => ({
      competency: text(`matrix.${index}.competency`),
      evidence: text(`matrix.${index}.evidence`),
      method: text(`matrix.${index}.method`),
      justification: text(`matrix.${index}.justification`),
      criteria: text(`matrix.${index}.criteria`).split(/\r?\n/).map(trimWs).filter(Boolean),
      limits: text(`matrix.${index}.limits`),
    })),
  });
}

/** Czego brakuje do zatwierdzenia. Pusta lista = profil kompletny. */
export function methodProfileProblems(content: MethodProfileContent, competencies: readonly string[]): string[] {
  const problems: string[] = [];
  if (!content.goal) problems.push('Uzupełnij cel stanowiska.');
  if (!content.expectedOutcome) problems.push('Uzupełnij oczekiwany wynik.');
  if (!content.constraints) problems.push('Uzupełnij ograniczenia stanowiska.');
  if (!content.responsibilityLevel) problems.push('Wybierz poziom odpowiedzialności.');
  const required = positionCompetencies({ required_competencies: competencies });
  if (!required.length) {
    problems.push('Profil stanowiska nie ma żadnej kompetencji. Najpierw dopisz kompetencje w profilu stanowiska.');
    return problems;
  }
  const rows = new Map(content.matrix.map(row => [key(row.competency), row]));
  for (const competency of required) {
    const row = rows.get(key(competency));
    if (!row) { problems.push(`Brakuje wiersza macierzy dla kompetencji „${competency}”.`); continue; }
    const gaps = [
      !row.evidence && 'oczekiwany dowód', !row.method && 'metodę oceny', !row.justification && 'uzasadnienie metody',
      !row.criteria.length && 'co najmniej jedno kryterium', !row.limits && 'granice wniosku',
    ].filter(Boolean);
    if (gaps.length) problems.push(`Kompetencja „${competency}”: uzupełnij ${gaps.join(', ')}.`);
  }
  const requiredKeys = new Set(required.map(key));
  for (const row of content.matrix) {
    if (!requiredKeys.has(key(row.competency))) problems.push(`Kompetencji „${row.competency}” nie ma już w profilu stanowiska. Usuń ten wiersz albo dopisz kompetencję w profilu.`);
  }
  return problems;
}

/**
 * Dopasowuje macierz do aktualnej listy kompetencji stanowiska: zachowuje
 * wpisane wiersze, dodaje puste dla nowych kompetencji, a wiersze kompetencji
 * usuniętych z profilu zostawia na końcu, żeby rekruter świadomie je usunął.
 */
export function alignMatrix(content: MethodProfileContent, competencies: readonly string[]): MethodProfileContent {
  const rows = new Map(content.matrix.map(row => [key(row.competency), row]));
  const required = positionCompetencies({ required_competencies: competencies });
  const requiredKeys = new Set(required.map(key));
  const aligned = required.map(competency => rows.get(key(competency))
    ?? { competency, evidence: '', method: '' as const, justification: '', criteria: [], limits: '' });
  const stale = content.matrix.filter(row => !requiredKeys.has(key(row.competency)));
  return { ...content, matrix: [...aligned, ...stale].slice(0, METHOD_LIMITS.rows) };
}

// --- błędy bazy -> komunikaty dla rekrutera ---------------------------------

const incompleteMessages: Record<string, string> = {
  goal: 'Uzupełnij cel stanowiska.',
  expectedOutcome: 'Uzupełnij oczekiwany wynik.',
  constraints: 'Uzupełnij ograniczenia stanowiska.',
  responsibilityLevel: 'Wybierz poziom odpowiedzialności.',
  'position.competencies': 'Profil stanowiska nie ma żadnej kompetencji. Najpierw dopisz kompetencje w profilu stanowiska.',
  'matrix.coverage': 'Macierz dowodów nie obejmuje wszystkich kompetencji z profilu stanowiska.',
  'matrix.unknown': 'W macierzy jest kompetencja, której nie ma już w profilu stanowiska. Usuń ten wiersz albo dopisz kompetencję w profilu.',
  'matrix.evidence': 'Dla każdej kompetencji podaj oczekiwany dowód.',
  'matrix.method': 'Dla każdej kompetencji wybierz metodę oceny.',
  'matrix.justification': 'Dla każdej kompetencji uzasadnij wybór metody.',
  'matrix.criteria': 'Dla każdej kompetencji podaj co najmniej jedno kryterium.',
  'matrix.limits': 'Dla każdej kompetencji opisz granice wniosku.',
};

export function methodProfileError(error: { code?: string | null; message?: string | null } | null | undefined): string {
  const message = error?.message ?? '';
  const incomplete = /method_profile_incomplete:([A-Za-z.]+)/.exec(message);
  if (incomplete) return `Nie można zatwierdzić: ${incompleteMessages[incomplete[1]] ?? 'profil metody jest niekompletny.'}`;
  if (error?.code === 'PT409' || message.includes('method_draft_changed')) return 'Szkic zmienił się w innym oknie. Odśwież stronę; Twoje odpowiedzi pozostały w formularzu.';
  if (error?.code === '42501' || message.includes('method_forbidden')) return 'Masz dostęp tylko do odczytu.';
  if (message.includes('method_position_archived')) return 'Stanowisko jest zarchiwizowane, więc profilu metody nie można już zmieniać.';
  if (message.includes('method_profile_invalid')) return 'Sprawdź pola formularza: któreś jest za długie albo ma niepoprawną treść.';
  return 'Nie udało się zapisać profilu metody. Twoje odpowiedzi pozostały w formularzu.';
}

// --- odczyt stanu z bazy -----------------------------------------------------

export type MethodDraft = { id: string; revision: number; content: MethodProfileContent; updated_at: string };
export type MethodApprovedVersion = {
  id: string; version_no: number; content: MethodProfileContent; content_hash: string; approved_at: string;
  position_snapshot: Record<string, unknown>;
};
export type MethodHistoryEntry = {
  id: string; version_no: number; approved_at: string; content_hash: string; responsibility_level: string;
};
export type MethodProfileState = {
  can_edit: boolean;
  /** Licznik zmian profilu metody stanowiska (szkic i zatwierdzenia); 0, gdy nic jeszcze nie zapisano. */
  revision: number;
  draft: MethodDraft | null; approved: MethodApprovedVersion | null; history: MethodHistoryEntry[];
};

function parseApproved(value: unknown): MethodApprovedVersion | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.version_no !== 'number' || typeof row.content_hash !== 'string'
    || typeof row.approved_at !== 'string') return null;
  return {
    id: row.id, version_no: row.version_no, content: parseMethodProfileContent(row.content), content_hash: row.content_hash,
    approved_at: row.approved_at,
    position_snapshot: row.position_snapshot && typeof row.position_snapshot === 'object' ? row.position_snapshot as Record<string, unknown> : {},
  };
}
export const parseMethodVersion = parseApproved;

/** Odpowiedź public.method_profile_state. Null, gdy kształt jest nieoczekiwany. */
export function parseMethodProfileState(value: unknown): MethodProfileState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  try {
    const rawDraft = state.draft as Record<string, unknown> | null | undefined;
    const draft = rawDraft && typeof rawDraft.id === 'string' && typeof rawDraft.revision === 'number'
      ? { id: rawDraft.id, revision: rawDraft.revision, content: parseMethodProfileContent(rawDraft.content), updated_at: String(rawDraft.updated_at ?? '') }
      : null;
    const history = Array.isArray(state.history) ? state.history.flatMap(item => {
      const row = item as Record<string, unknown> | null;
      return row && typeof row.id === 'string' && typeof row.version_no === 'number'
        ? [{ id: row.id, version_no: row.version_no, approved_at: String(row.approved_at ?? ''),
            content_hash: String(row.content_hash ?? ''), responsibility_level: String(row.responsibility_level ?? '') }]
        : [];
    }) : [];
    if (typeof state.revision !== 'number' || !Number.isInteger(state.revision) || state.revision < 0) return null;
    return { can_edit: state.can_edit === true, revision: state.revision, draft, approved: parseApproved(state.approved), history };
  } catch { return null; }
}
