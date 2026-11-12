// SC-PROCESS / #277, część A — diagnostyka rekrutacji przy małym napływie CV.
// Kontrakt: docs/sc-process-277.md. Czyste funkcje, bez bazy i bez wywołań AI:
//  * parseDiagnosticForm() / parseDiagnosticContent() — postać kanoniczna zapisu;
//  * diagnosticProblems() — czego brakuje, w tym reguła „najpierw sprawdź pięć
//    obszarów, potem zmieniaj budżet";
//  * proposeDiagnosticAreas() — deterministyczne podpowiedzi, od czego zacząć.
// Te same reguły egzekwuje baza (process.normalize_content
// i public.process_record_diagnostic w 20261112140000_sc_process_diagnostics.sql);
// baza jest ostateczną granicą.
// Moduł nie ocenia kandydatów, nie podejmuje żadnej decyzji i niczego nie zmienia:
// podpowiedzi są wskazówką dla rekrutera, a zalecenie wpisuje człowiek.

export const diagnosticAreas = ['channels', 'role_name', 'tasks', 'job_ad', 'market'] as const;
export type DiagnosticArea = (typeof diagnosticAreas)[number];
export const diagnosticAreaLabels: Record<DiagnosticArea, string> = {
  channels: 'Kanały', role_name: 'Nazwa roli', tasks: 'Zadania', job_ad: 'Ogłoszenie', market: 'Warunki rynkowe',
};
export const diagnosticAreaQuestions: Record<DiagnosticArea, string> = {
  channels: 'Gdzie ogłoszenie jest opublikowane i czy kandydaci na to stanowisko tam zaglądają?',
  role_name: 'Czy nazwa stanowiska jest taka, jakiej kandydaci szukają — bez wewnętrznych skrótów i żargonu?',
  tasks: 'Czy zadania są opisane konkretnie, tak żeby kandydat wiedział, co będzie robić?',
  job_ad: 'Czy ogłoszenie jest czytelne, aktualne i mówi, co firma oferuje, a nie tylko czego wymaga?',
  market: 'Czy wynagrodzenie i benefity odpowiadają rynkowi oraz czy miejsce pracy (biuro, hybryda, zdalnie) nie zawęża grona kandydatów?',
};

export const diagnosticStatuses = ['ok', 'problem', 'not_checked'] as const;
export type DiagnosticStatus = (typeof diagnosticStatuses)[number];
export const diagnosticStatusLabels: Record<DiagnosticStatus, string> = {
  ok: 'Sprawdzone — w porządku', problem: 'Sprawdzone — do poprawy', not_checked: 'Jeszcze nie sprawdzone',
};

export const recruitmentChannels = ['job_board', 'company_site', 'social_media', 'referrals', 'agency', 'employment_office', 'other'] as const;
export type RecruitmentChannel = (typeof recruitmentChannels)[number];
export const recruitmentChannelLabels: Record<RecruitmentChannel, string> = {
  job_board: 'Portal z ogłoszeniami', company_site: 'Strona firmy', social_media: 'Media społecznościowe',
  referrals: 'Polecenia pracowników', agency: 'Agencja rekrutacyjna', employment_office: 'Urząd pracy', other: 'Inny kanał',
};

export const recommendationKinds = ['fix_areas', 'keep_watching', 'change_budget'] as const;
export type RecommendationKind = (typeof recommendationKinds)[number];
export const recommendationKindLabels: Record<RecommendationKind, string> = {
  fix_areas: 'Popraw wskazane obszary (bez zmiany budżetu)',
  keep_watching: 'Obserwuj dalej, bez zmian',
  change_budget: 'Zmień budżet rekrutacji',
};

export const DIAGNOSTIC_LIMITS = { note: 500, recommendation: 1000 } as const;

export type DiagnosticItem = { status: DiagnosticStatus; note: string };
export type DiagnosticContent = { areas: Record<DiagnosticArea, DiagnosticItem>; channelsUsed: RecruitmentChannel[] };

const isOneOf = <T extends string>(list: readonly T[]) => (value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);
export const isDiagnosticArea = isOneOf(diagnosticAreas);
export const isDiagnosticStatus = isOneOf(diagnosticStatuses);
export const isRecruitmentChannel = isOneOf(recruitmentChannels);
export const isRecommendationKind = isOneOf(recommendationKinds);

/** Ten sam zestaw białych znaków co process.trim_ws() w bazie. */
export const trimWs = (text: string) => text.replace(/^[ \t\n\r\f\v ]+|[ \t\n\r\f\v ]+$/g, '');
const controlChars = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function cleanText(value: unknown, max: number, label: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`Pole „${label}” ma niepoprawną treść.`);
  const text = trimWs(value);
  if (text.length > max) throw new Error(`Skróć pole „${label}” do ${max} znaków.`);
  if (controlChars.test(text)) throw new Error(`Pole „${label}” zawiera niedozwolone znaki.`);
  return text;
}

/** Postać kanoniczna diagnozy. Rzuca błąd z komunikatem po polsku, gdy kształt lub limit jest zły. */
export function parseDiagnosticContent(value: unknown): DiagnosticContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Niepoprawny zapis diagnozy.');
  const source = value as Record<string, unknown>;
  const rawAreas = source.areas;
  if (!rawAreas || typeof rawAreas !== 'object' || Array.isArray(rawAreas)) throw new Error('Niepoprawny zapis diagnozy.');
  if (Object.keys(rawAreas).some(key => !isDiagnosticArea(key))) throw new Error('Niepoprawny zapis diagnozy.');
  const areas = {} as Record<DiagnosticArea, DiagnosticItem>;
  for (const area of diagnosticAreas) {
    const item = (rawAreas as Record<string, unknown>)[area];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Wybierz status obszaru „${diagnosticAreaLabels[area]}”.`);
    const { status, note } = item as Record<string, unknown>;
    if (!isDiagnosticStatus(status)) throw new Error(`Wybierz status obszaru „${diagnosticAreaLabels[area]}”.`);
    areas[area] = { status, note: cleanText(note, DIAGNOSTIC_LIMITS.note, `${diagnosticAreaLabels[area]} — notatka`) };
  }
  const rawChannels = source.channelsUsed ?? [];
  if (!Array.isArray(rawChannels) || rawChannels.length > recruitmentChannels.length
    || rawChannels.some(item => !isRecruitmentChannel(item)) || new Set(rawChannels).size !== rawChannels.length) {
    throw new Error('Niepoprawna lista kanałów.');
  }
  // Stała kolejność katalogu: ta sama treść daje ten sam zapis (tak samo w bazie).
  return { areas, channelsUsed: recruitmentChannels.filter(channel => rawChannels.includes(channel)) };
}

export type DiagnosticSubmission = { content: DiagnosticContent; recommendationKind: RecommendationKind; recommendation: string };

/** Formularz panelu -> postać kanoniczna. Pola: area.<obszar>.status, area.<obszar>.note, channel (wiele), recommendationKind, recommendation. */
export function parseDiagnosticForm(form: FormData): DiagnosticSubmission {
  const text = (name: string) => { const value = form.get(name); return typeof value === 'string' ? value : ''; };
  const content = parseDiagnosticContent({
    areas: Object.fromEntries(diagnosticAreas.map(area => [area, { status: text(`area.${area}.status`), note: text(`area.${area}.note`) }])),
    channelsUsed: Array.from(new Set(form.getAll('channel').filter(item => typeof item === 'string'))),
  });
  const kind = text('recommendationKind');
  if (!isRecommendationKind(kind)) throw new Error('Wybierz zalecenie.');
  return { content, recommendationKind: kind, recommendation: cleanText(text('recommendation'), DIAGNOSTIC_LIMITS.recommendation, 'Zalecenie — uzasadnienie') };
}

export const uncheckedAreas = (content: DiagnosticContent): DiagnosticArea[] =>
  diagnosticAreas.filter(area => content.areas[area].status === 'not_checked');

/**
 * Czego brakuje, żeby zapisać diagnozę. Pusta lista = można zapisać.
 * Najważniejsza reguła (#277): kanały, nazwę roli, zadania, ogłoszenie i warunki
 * rynkowe sprawdza się PRZED zmianą budżetu.
 */
export function diagnosticProblems({ content, recommendationKind, recommendation }: DiagnosticSubmission): string[] {
  const problems: string[] = [];
  for (const area of diagnosticAreas) {
    if (content.areas[area].status === 'problem' && !content.areas[area].note) {
      problems.push(`Obszar „${diagnosticAreaLabels[area]}”: opisz krótko, co jest do poprawy.`);
    }
  }
  const unchecked = uncheckedAreas(content);
  if (recommendationKind === 'change_budget' && unchecked.length) {
    problems.push(`Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary. Jeszcze nie sprawdzone: ${unchecked.map(area => diagnosticAreaLabels[area]).join(', ')}.`);
  }
  if (recommendationKind === 'fix_areas' && !diagnosticAreas.some(area => content.areas[area].status === 'problem')) {
    problems.push('Zalecenie „popraw wskazane obszary” wymaga co najmniej jednego obszaru oznaczonego „do poprawy”.');
  }
  if (!recommendation) problems.push('Wpisz uzasadnienie zalecenia.');
  return problems;
}

export const emptyDiagnosticContent = (): DiagnosticContent => ({
  areas: Object.fromEntries(diagnosticAreas.map(area => [area, { status: 'not_checked', note: '' }])) as Record<DiagnosticArea, DiagnosticItem>,
  channelsUsed: [],
});

// --- podpowiedzi: od czego zacząć -------------------------------------------

/** Progi są umowne i jawne: służą wyłącznie do podpowiedzi, nie do decyzji. */
export const INFLOW_RULES = { minDaysToJudge: 7, lowLast14Days: 5, longTitleChars: 60, longTitleWords: 6, fewTasks: 3, shortAdChars: 200 } as const;

export type InflowLevel = 'not_measured' | 'none' | 'low' | 'ok';
export type DiagnosticFacts = {
  /** Status rekrutacji: draft / open / paused / closed. */
  status: string;
  daysOpen: number | null;
  applicationsTotal: number;
  applicationsLast14Days: number;
  title: string;
  description: string | null;
  tasks: readonly string[];
};
export type DiagnosticHint = { area: DiagnosticArea; reason: string };
export type DiagnosticProposal = { level: InflowLevel; levelText: string; hints: DiagnosticHint[] };

const jargon = /\b(ninja|rockstar|guru|wizard|hero|evangelist|jedi|samuraj)\b/i;
const internalCode = /\b[A-ZŁŚŻŹĆŃ]{2,}[-/]?\d+\b|\b(?:lvl|level|poziom)\s*\d+\b|\b[IVX]{2,}\b/;
const salaryWords = /(?<![a-ząćęłńóśźż])zł(?![a-ząćęłńóśźż])|\bpln\b|wynagrodzeni|widełk|stawk|brutto|netto|pensj/i;
const placeWords = /zdaln|hybryd|stacjonarn|biur|lokalizacj|miejsce pracy|siedzib/i;

/** Poziom napływu CV. „not_measured" to brak podstaw do oceny, a nie zero zgłoszeń. */
export function inflowLevel(facts: Pick<DiagnosticFacts, 'status' | 'daysOpen' | 'applicationsTotal' | 'applicationsLast14Days'>): { level: InflowLevel; levelText: string } {
  if (facts.status === 'draft') return { level: 'not_measured', levelText: 'Brak pomiaru: rekrutacja jest jeszcze szkicem, więc nie zbiera zgłoszeń.' };
  if (facts.daysOpen === null || !Number.isFinite(facts.daysOpen)) return { level: 'not_measured', levelText: 'Brak pomiaru: nie wiadomo, od kiedy trwa rekrutacja.' };
  if (facts.daysOpen < INFLOW_RULES.minDaysToJudge) {
    return { level: 'not_measured', levelText: `Brak pomiaru: rekrutacja trwa ${facts.daysOpen} dni, a napływ oceniamy najwcześniej po ${INFLOW_RULES.minDaysToJudge} dniach.` };
  }
  if (facts.applicationsTotal === 0) return { level: 'none', levelText: `Przez ${facts.daysOpen} dni nie wpłynęło żadne CV.` };
  if (facts.applicationsLast14Days < INFLOW_RULES.lowLast14Days) {
    return { level: 'low', levelText: `Mały napływ: ${facts.applicationsLast14Days} CV w ostatnich 14 dniach (łącznie ${facts.applicationsTotal}).` };
  }
  return { level: 'ok', levelText: `Napływ nie wygląda na mały: ${facts.applicationsLast14Days} CV w ostatnich 14 dniach (łącznie ${facts.applicationsTotal}).` };
}

/**
 * Deterministyczna podpowiedź, które obszary sprawdzić w pierwszej kolejności.
 * To wskazówka z prostych faktów (liczby zgłoszeń, długość tytułu, brak zadań,
 * brak informacji o wynagrodzeniu) — nie diagnoza i nie decyzja. Kolejność
 * wyniku = kolejność sprawdzania.
 */
export function proposeDiagnosticAreas(facts: DiagnosticFacts): DiagnosticProposal {
  const { level, levelText } = inflowLevel(facts);
  const hints: DiagnosticHint[] = [];
  const title = trimWs(facts.title ?? '');
  const ad = trimWs(facts.description ?? '');
  const tasks = facts.tasks.map(trimWs).filter(Boolean);

  if (level === 'none') {
    hints.push({ area: 'channels', reason: 'Nie wpłynęło żadne CV — najpierw sprawdź, czy ogłoszenie jest w ogóle opublikowane i gdzie.' });
  } else if (level === 'low' && facts.applicationsLast14Days === 0) {
    hints.push({ area: 'channels', reason: 'Zgłoszenia przestały napływać — sprawdź, czy ogłoszenie nadal jest widoczne i czy nie wygasło.' });
  } else if (level === 'low') {
    hints.push({ area: 'channels', reason: 'Zgłoszeń jest mało — sprawdź, czy ogłoszenie jest tam, gdzie szukają kandydaci na to stanowisko.' });
  }

  const titleWords = title.split(/\s+/).filter(Boolean).length;
  if (jargon.test(title) || internalCode.test(title)) {
    hints.push({ area: 'role_name', reason: 'Nazwa stanowiska zawiera żargon lub wewnętrzne oznaczenie, którego kandydaci nie wpisują w wyszukiwarkę.' });
  } else if (title.length > INFLOW_RULES.longTitleChars || titleWords > INFLOW_RULES.longTitleWords) {
    hints.push({ area: 'role_name', reason: `Nazwa stanowiska jest długa (${title.length} znaków, ${titleWords} słów) — krótsza, powszechnie używana nazwa jest łatwiejsza do znalezienia.` });
  }

  if (!tasks.length) {
    hints.push({ area: 'tasks', reason: 'Profil stanowiska nie ma żadnych zadań — kandydat nie wie, co miałby robić.' });
  } else if (tasks.length < INFLOW_RULES.fewTasks) {
    hints.push({ area: 'tasks', reason: `Profil stanowiska ma tylko ${tasks.length} ${tasks.length === 1 ? 'zadanie' : 'zadania'} — dopisz, czym ta osoba zajmuje się na co dzień.` });
  }

  if (!ad) {
    hints.push({ area: 'job_ad', reason: 'Stanowisko nie ma opisu — sprawdź, co faktycznie jest w opublikowanym ogłoszeniu.' });
  } else if (ad.length < INFLOW_RULES.shortAdChars) {
    hints.push({ area: 'job_ad', reason: `Opis stanowiska jest krótki (${ad.length} znaków) — sprawdź, czy ogłoszenie mówi, co firma oferuje.` });
  }

  const missing = [!salaryWords.test(ad) && 'wynagrodzeniu', !placeWords.test(ad) && 'miejscu pracy (biuro, hybryda, zdalnie)'].filter(Boolean);
  if (missing.length) {
    hints.push({ area: 'market', reason: `W opisie stanowiska nie widać informacji o ${missing.join(' ani o ')} — porównaj warunki z rynkiem, zanim zmienisz budżet.` });
  }
  return { level, levelText, hints };
}

// --- błędy bazy -> komunikaty dla rekrutera ---------------------------------

export function processError(error: { code?: string | null; message?: string | null } | null | undefined): string {
  const message = error?.message ?? '';
  const budget = /process_budget_requires_full_check:([a-z_,]+)/.exec(message);
  if (budget) {
    const names = budget[1].split(',').filter(isDiagnosticArea).map(area => diagnosticAreaLabels[area]);
    return `Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary. Jeszcze nie sprawdzone: ${names.join(', ')}.`;
  }
  const incomplete = /process_diagnostic_incomplete:([a-z_.]+)/.exec(message);
  if (incomplete) {
    if (incomplete[1] === 'recommendation') return 'Wpisz uzasadnienie zalecenia.';
    if (incomplete[1] === 'fix_areas.problem') return 'Zalecenie „popraw wskazane obszary” wymaga co najmniej jednego obszaru oznaczonego „do poprawy”.';
    const area = incomplete[1].replace(/\.note$/, '');
    if (isDiagnosticArea(area)) return `Obszar „${diagnosticAreaLabels[area]}”: opisz krótko, co jest do poprawy.`;
    return 'Uzupełnij brakujące pola diagnozy.';
  }
  if (error?.code === 'PT409' || message.includes('process_record_changed')) return 'Ktoś zapisał w międzyczasie inną diagnozę. Odśwież stronę; Twoje odpowiedzi pozostały w formularzu.';
  if (error?.code === '42501' || message.includes('process_forbidden')) return 'Masz dostęp tylko do odczytu.';
  if (message.includes('process_diagnostic_limit')) return 'Ta rekrutacja ma już maksymalną liczbę zapisów diagnozy.';
  if (message.includes('process_diagnostic_invalid')) return 'Sprawdź pola formularza: któreś jest za długie albo ma niepoprawną treść.';
  return 'Nie udało się zapisać diagnozy. Twoje odpowiedzi pozostały w formularzu.';
}

// --- odczyt stanu z bazy -----------------------------------------------------

export type Inflow = {
  status: string; started_at: string; start_source: 'opened_at' | 'created_at'; closed_at: string | null; days_open: number;
  total: number; last_7_days: number; last_14_days: number; last_30_days: number;
  first_application_at: string | null; last_application_at: string | null;
  weekly: { weeks_ago: number; count: number }[];
};
export type InflowSnapshot = { total: number | null; last_14_days: number | null; last_30_days: number | null; days_open: number | null };
export type DiagnosticRecord = {
  id: string; record_no: number; content: DiagnosticContent; recommendation_kind: RecommendationKind; recommendation: string;
  inflow_snapshot: InflowSnapshot; created_at: string;
};
export type DiagnosticsState = { can_edit: boolean; latest_record_no: number; inflow: Inflow; history: DiagnosticRecord[] };

const count = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
const stamp = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

function parseInflow(value: unknown): Inflow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const numbers = [row.days_open, row.total, row.last_7_days, row.last_14_days, row.last_30_days].map(count);
  if (numbers.some(item => item === null) || typeof row.status !== 'string' || typeof row.started_at !== 'string'
    || (row.start_source !== 'opened_at' && row.start_source !== 'created_at') || !Array.isArray(row.weekly)) return null;
  const weekly = row.weekly.flatMap(item => {
    const week = item as Record<string, unknown> | null;
    const weeksAgo = count(week?.weeks_ago), weekCount = count(week?.count);
    return weeksAgo === null || weekCount === null ? [] : [{ weeks_ago: weeksAgo, count: weekCount }];
  });
  if (weekly.length !== row.weekly.length) return null;
  const [days_open, total, last_7_days, last_14_days, last_30_days] = numbers as number[];
  return {
    status: row.status, started_at: row.started_at, start_source: row.start_source, closed_at: stamp(row.closed_at), days_open,
    total, last_7_days, last_14_days, last_30_days,
    first_application_at: stamp(row.first_application_at), last_application_at: stamp(row.last_application_at), weekly,
  };
}

/** Odpowiedź public.process_diagnostics_state. Null, gdy kształt jest nieoczekiwany. */
export function parseDiagnosticsState(value: unknown): DiagnosticsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  const inflow = parseInflow(state.inflow);
  const latest = count(state.latest_record_no);
  if (!inflow || latest === null || !Array.isArray(state.history)) return null;
  try {
    const history = state.history.map(item => {
      const row = item as Record<string, unknown>;
      const recordNo = count(row.record_no);
      if (typeof row.id !== 'string' || !recordNo || !isRecommendationKind(row.recommendation_kind) || typeof row.recommendation !== 'string') {
        throw new Error('unexpected');
      }
      const snapshot = (row.inflow_snapshot && typeof row.inflow_snapshot === 'object' ? row.inflow_snapshot : {}) as Record<string, unknown>;
      return {
        id: row.id, record_no: recordNo, content: parseDiagnosticContent(row.content), recommendation_kind: row.recommendation_kind,
        recommendation: row.recommendation, created_at: String(row.created_at ?? ''),
        inflow_snapshot: { total: count(snapshot.total), last_14_days: count(snapshot.last_14_days), last_30_days: count(snapshot.last_30_days), days_open: count(snapshot.days_open) },
      };
    });
    return { can_edit: state.can_edit === true, latest_record_no: latest, inflow, history };
  } catch { return null; }
}
