// SC-015 / #268 — oznaczenie wymagania stanowiska: konieczne, dodatkowe, nieoznaczone.
// Kontrakt: docs/sc-015-free-candidate-report.md. Tę warstwę czytają oba widoki
// (raport pojedynczego CV i porównanie kandydatów); żaden z nich nie interpretuje
// wierszy bazy samodzielnie.

export const requirementFlags = ['required', 'additional'] as const;
export type RequirementFlag = typeof requirementFlags[number];
/** Trzeci stan: brak wiersza albo oznaczenie sprzed zmiany treści wymagania. */
export type RequirementMark = RequirementFlag | 'unmarked';

export const requirementMarkLabels: Record<RequirementMark, string> = {
  required: 'Konieczne',
  additional: 'Dodatkowe',
  unmarked: 'Nieoznaczone',
};

/** Konieczne najpierw, nieoznaczone przed dodatkowymi: nikt jeszcze nie uznał ich za mniej ważne. */
export const requirementMarkOrder: RequirementMark[] = ['required', 'unmarked', 'additional'];

export const criterionKinds = ['task', 'kpi', 'competency'] as const;
export type CriterionKind = typeof criterionKinds[number];
export const criterionKindLabels: Record<CriterionKind, string> = {
  task: 'Zadanie', kpi: 'Miernik sukcesu', competency: 'Kompetencja',
};

export type PositionRequirement = { id: string; kind: CriterionKind; text: string; order: number };
export type RequirementFlagRow = { criterion_id: string; criterion_text: string; flag: string };

/** Shared guard for the requirement-flags RPC used by both FREE report views.
 * A duplicated ID would otherwise silently overwrite a required/optional mark.
 * Unknown textual flags are retained so historic values still map to 'unmarked'.
 */
export function parseRequirementFlagRows(value: unknown): RequirementFlagRow[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.criterion_id !== 'string' || !row.criterion_id.trim()
      || typeof row.criterion_text !== 'string' || typeof row.flag !== 'string'
      || seen.has(row.criterion_id)) return null;
    seen.add(row.criterion_id);
  }
  return value as RequirementFlagRow[];
}

const criterionIdPattern = /^(task|kpi|competency):[1-9][0-9]{0,2}$/;

/**
 * Wymagania aktualnego profilu stanowiska, w tej samej kolejności i z tymi samymi
 * identyfikatorami, których używa analiza (lib/screening.ts): task:1, kpi:2, competency:3.
 * Jedno źródło tych identyfikatorów po stronie odczytu — gdyby się rozjechały,
 * oznaczenia i wyniki analizy wskazywałyby różne wymagania.
 */
export function positionRequirements(position: {
  tasks: readonly string[]; kpis: readonly string[]; required_competencies: readonly string[];
}): PositionRequirement[] {
  const groups = [
    ['task', position.tasks], ['kpi', position.kpis], ['competency', position.required_competencies],
  ] as const;
  let order = 0;
  return groups.flatMap(([kind, items]) =>
    items.map((text, index) => ({ id: `${kind}:${index + 1}`, kind, text, order: order++ })));
}

/**
 * Oznaczenie obowiązuje tylko wtedy, gdy zapisany tekst zgadza się z tekstem, który
 * stoi dziś pod tym identyfikatorem. Identyfikator jest pozycyjny, więc po przestawieniu
 * kolejności wymagań wskazuje inne wymaganie — wtedy lepiej poprosić rekrutera o ponowne
 * oznaczenie niż po cichu przykleić wymaganiu cudzą etykietę.
 */
export function resolveRequirementMarks(
  requirements: readonly PositionRequirement[], rows: readonly RequirementFlagRow[],
): Map<string, RequirementMark> {
  const saved = new Map<string, RequirementFlagRow>();
  for (const row of rows) {
    if (typeof row?.criterion_id !== 'string' || !criterionIdPattern.test(row.criterion_id)) continue;
    if (!(requirementFlags as readonly string[]).includes(row.flag)) continue;
    saved.set(row.criterion_id, row);
  }
  const marks = new Map<string, RequirementMark>();
  for (const requirement of requirements) {
    const row = saved.get(requirement.id);
    const current = row && row.criterion_text.trim() === requirement.text.trim();
    marks.set(requirement.id, current ? row.flag as RequirementFlag : 'unmarked');
  }
  return marks;
}

/** Konieczne → nieoznaczone → dodatkowe, wewnątrz grupy w kolejności z profilu stanowiska. */
export function sortByRequirementMark<T extends { id: string; order: number }>(
  items: readonly T[], marks: ReadonlyMap<string, RequirementMark>,
): T[] {
  const rank = (id: string) => {
    const index = requirementMarkOrder.indexOf(marks.get(id) ?? 'unmarked');
    return index < 0 ? requirementMarkOrder.indexOf('unmarked') : index;
  };
  return [...items].sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order);
}

export function countRequirementMarks(marks: ReadonlyMap<string, RequirementMark>) {
  const counts: Record<RequirementMark, number> = { required: 0, additional: 0, unmarked: 0 };
  marks.forEach((mark: RequirementMark) => { counts[mark]++; });
  return counts;
}
