// SC-PROCESS / #277, część A — katalog wskaźników rekrutacji: definicja, zakres
// danych i jawny stan pomiaru. Kontrakt: docs/sc-process-277.md.
// Liczby pochodzą z public.process_recruitment_metrics
// (20261112140000_sc_process_diagnostics.sql); ten moduł dokłada słowną
// definicję i pilnuje jednej zasady: BRAK POMIARU TO NIE ZERO. Wskaźnik bez
// danych ma stan `not_measured`, wartość null i powód — nigdy 0.
// Czyste funkcje, bez bazy i bez AI. Moduł nie ocenia ludzi i nie podejmuje decyzji.

export const METRICS_DEFINITION_VERSION = 'process-metrics-v1';

export const metricKeys = [
  'days_to_first_application', 'days_to_first_shortlist', 'days_to_first_next_stage_decision',
  'median_days_application_to_decision', 'recruitment_duration_days', 'days_to_hire',
  'probation_pass_rate', 'retention_rate',
] as const;
export type MetricKey = (typeof metricKeys)[number];
export type MetricUnit = 'days' | 'percent';
export type MetricReason = 'no_data' | 'too_few_rows' | 'recruitment_not_closed' | 'requires_hire_date'
  | 'requires_post_hire_observations' | 'unavailable';

export type MetricDefinition = {
  label: string; unit: MetricUnit;
  /** Co dokładnie liczymy. */
  definition: string;
  /** Z jakich danych i w jakim zakresie. */
  dataScope: string;
  /** false = dziś nie da się policzyć z istniejących danych (część B). */
  availableToday: boolean;
};

const start = 'Początek rekrutacji to data jej otwarcia, a gdy nie została zapisana — data utworzenia rekrutacji.';
export const metricCatalogue: Record<MetricKey, MetricDefinition> = {
  days_to_first_application: {
    label: 'Czas do pierwszego CV', unit: 'days', availableToday: true,
    definition: `Liczba dni od początku rekrutacji do pierwszego zgłoszenia kandydata. ${start}`,
    dataScope: 'Wszystkie zgłoszenia tej rekrutacji, które są dziś w systemie (zgłoszenia usunięte na żądanie kandydata nie są liczone).',
  },
  days_to_first_shortlist: {
    label: 'Czas do pierwszej krótkiej listy', unit: 'days', availableToday: true,
    definition: `Liczba dni od początku rekrutacji do chwili, gdy rekruter po raz pierwszy dodał kandydata do krótkiej listy. ${start}`,
    dataScope: 'Wszystkie wpisy krótkiej listy tej rekrutacji, także później wycofane.',
  },
  days_to_first_next_stage_decision: {
    label: 'Czas do pierwszej decyzji „kolejny etap”', unit: 'days', availableToday: true,
    definition: `Liczba dni od początku rekrutacji do pierwszej zapisanej decyzji rekrutera o zaproszeniu kandydata do kolejnego etapu. ${start}`,
    dataScope: 'Zapisane decyzje rekrutera „kolejny etap” w tej rekrutacji. Decyzję zawsze podejmuje człowiek; wskaźnik mierzy tylko czas.',
  },
  median_days_application_to_decision: {
    label: 'Typowy czas od CV do decyzji rekrutera', unit: 'days', availableToday: true,
    definition: 'Mediana liczby dni od zgłoszenia kandydata do pierwszej zapisanej decyzji rekrutera w jego sprawie (kolejny etap, wstrzymanie albo zamknięcie).',
    dataScope: 'Tylko zgłoszenia tej rekrutacji, które mają co najmniej jedną zapisaną decyzję; po jednym pomiarze na zgłoszenie. Wymaga co najmniej 3 takich zgłoszeń.',
  },
  recruitment_duration_days: {
    label: 'Czas trwania rekrutacji', unit: 'days', availableToday: true,
    definition: `Liczba dni od początku rekrutacji do jej zamknięcia. ${start}`,
    dataScope: 'Daty tej jednej rekrutacji. Liczone dopiero, gdy rekrutacja ma zapisaną datę zamknięcia.',
  },
  days_to_hire: {
    label: 'Czas do zatrudnienia', unit: 'days', availableToday: false,
    definition: 'Liczba dni od początku rekrutacji do dnia zatrudnienia wybranej osoby.',
    dataScope: 'Wymaga daty zatrudnienia, której system dziś nie zapisuje. Zostanie dodana razem z obserwacjami po zatrudnieniu (część B).',
  },
  probation_pass_rate: {
    label: 'Przejście okresu próbnego', unit: 'percent', availableToday: false,
    definition: 'Odsetek osób zatrudnionych w tej rekrutacji, które zakończyły okres próbny i pozostały w firmie.',
    dataScope: 'Obserwacje 30/90/180 dni są mierzone osobno przez funkcję respektującą odrębne uprawnienia do celów oceny.',
  },
  retention_rate: {
    label: 'Retencja', unit: 'percent', availableToday: false,
    definition: 'Odsetek osób zatrudnionych w tej rekrutacji, które nadal pracują w firmie po 90 i po 180 dniach.',
    dataScope: 'Obserwacje 30/90/180 dni są mierzone osobno przez funkcję respektującą odrębne uprawnienia do celów oceny.',
  },
};

export const metricReasonLabels: Record<MetricReason, string> = {
  no_data: 'nie ma jeszcze danych, z których można to policzyć',
  too_few_rows: 'za mało danych, żeby wynik coś znaczył',
  recruitment_not_closed: 'rekrutacja nie została jeszcze zamknięta',
  requires_hire_date: 'system nie zapisuje jeszcze daty zatrudnienia',
  requires_post_hire_observations: 'pomiar po zatrudnieniu wymaga odrębnego zakresu uprawnień; sprawdź tabelę dalszych obserwacji',
  unavailable: 'nie udało się odczytać pomiaru',
};
const isReason = (value: unknown): value is MetricReason => typeof value === 'string' && Object.hasOwn(metricReasonLabels, value);

export type MetricScope = { source: string | null; rows: number; population: number | null; minRows: number | null; periodFrom: string | null; periodTo: string | null };
export type MetricResult = MetricDefinition & {
  key: MetricKey;
  state: 'measured' | 'not_measured';
  /** Liczba tylko przy state = 'measured' (może być 0 lub ujemna); przy braku pomiaru zawsze null. */
  value: number | null;
  reason: MetricReason | null;
  scope: MetricScope;
  /** Gotowy tekst dla panelu: wynik albo „Brak pomiaru: …". */
  display: string;
};

const sourceLabels: Record<string, string> = {
  applications: 'zgłoszenia', recruitment_shortlist_entries: 'wpisy krótkiej listy',
  application_decision_events: 'zapisane decyzje rekrutera', recruitments: 'daty rekrutacji',
};
const emptyScope: MetricScope = { source: null, rows: 0, population: null, minRows: null, periodFrom: null, periodTo: null };

function parseScope(value: unknown): MetricScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyScope;
  const row = value as Record<string, unknown>;
  const whole = (item: unknown) => typeof item === 'number' && Number.isInteger(item) && item >= 0 ? item : null;
  const text = (item: unknown) => typeof item === 'string' && item ? item : null;
  return { source: text(row.source), rows: whole(row.rows) ?? 0, population: whole(row.population), minRows: whole(row.min_rows),
    periodFrom: text(row.period_from), periodTo: text(row.period_to) };
}

export function formatMetricValue(value: number, unit: MetricUnit): string {
  const number = value.toLocaleString('pl-PL', { maximumFractionDigits: 1 });
  return unit === 'percent' ? `${number}%` : `${number} dni`;
}

const notMeasured = (key: MetricKey, reason: MetricReason, scope: MetricScope = emptyScope): MetricResult => ({
  key, ...metricCatalogue[key], state: 'not_measured', value: null, reason, scope,
  display: `Brak pomiaru: ${metricReasonLabels[reason]}.`,
});

/**
 * Łączy odpowiedź bazy z katalogiem. Zawsze zwraca wszystkie wskaźniki katalogu,
 * w kolejności katalogu. Wszystko, czego nie da się bezpiecznie odczytać jako
 * pomiar (brak wiersza, zły kształt, inna wersja definicji, wartość nie-liczbowa),
 * staje się brakiem pomiaru — nigdy zerem. Wskaźniki niedostępne dziś
 * (availableToday = false) są brakiem pomiaru niezależnie od odpowiedzi bazy.
 */
export function describeMetrics(raw: unknown): MetricResult[] {
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const rows = new Map<string, Record<string, unknown>>();
  if (payload && payload.definition_version === METRICS_DEFINITION_VERSION && Array.isArray(payload.metrics)) {
    for (const item of payload.metrics as unknown[]) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).key === 'string') {
        rows.set((item as Record<string, unknown>).key as string, item as Record<string, unknown>);
      }
    }
  }
  return metricKeys.map(key => {
    const definition = metricCatalogue[key];
    const row = rows.get(key);
    if (!definition.availableToday) {
      return notMeasured(key, key === 'days_to_hire' ? 'requires_hire_date' : 'requires_post_hire_observations');
    }
    if (!row) return notMeasured(key, 'unavailable');
    const scope = parseScope(row.scope);
    if (row.state === 'measured' && typeof row.value === 'number' && Number.isFinite(row.value) && row.unit === definition.unit) {
      return { key, ...definition, state: 'measured', value: row.value, reason: null, scope, display: formatMetricValue(row.value, definition.unit) };
    }
    if (row.state === 'not_measured' && row.value === null && isReason(row.reason)) return notMeasured(key, row.reason, scope);
    return notMeasured(key, 'unavailable', scope);
  });
}

/** Zdanie o zakresie danych użytych w tym konkretnym pomiarze. */
export function describeScope(metric: MetricResult): string {
  const { scope } = metric;
  if (!scope.source) return 'Żadne dane nie zostały użyte.';
  const parts = [`Źródło: ${sourceLabels[scope.source] ?? scope.source}, wierszy: ${scope.rows}`];
  if (scope.population !== null) parts.push(`z ${scope.population} zgłoszeń w rekrutacji`);
  if (scope.minRows !== null) parts.push(`wymagane minimum: ${scope.minRows}`);
  return `${parts.join(', ')}.`;
}
