export type ExerciseKind = 'competency_test' | 'assessment_center';
export type ExerciseCriterion = { competency: string; below: string; meets: string; above: string };
export type ExerciseDefinition = {
  kind: ExerciseKind; title: string; instructions: string; expectedOutput: string;
  durationMinutes: number; criteria: ExerciseCriterion[];
};

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label}: wymagany tekst do ${max} znaków.`);
  }
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Nieprawidłowa definicja zadania.');
  return value as Record<string, unknown>;
}

/** Validates a human-authored exercise, never generates scores or hiring decisions. */
export function parseExerciseDefinition(input: unknown): ExerciseDefinition {
  const value = record(input);
  if (value.kind !== 'competency_test' && value.kind !== 'assessment_center') throw new Error('Wybierz rodzaj zadania.');
  if (!Number.isInteger(value.durationMinutes) || (value.durationMinutes as number) < 1 || (value.durationMinutes as number) > 180) {
    throw new Error('Czas zadania musi wynosić od 1 do 180 minut.');
  }
  if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 12) {
    throw new Error('Zadanie wymaga od 1 do 12 kryteriów oceny.');
  }
  const seen = new Set<string>();
  const criteria = value.criteria.map((item): ExerciseCriterion => {
    const criterion = record(item);
    const competency = text(criterion.competency, 'Kompetencja', 200);
    const key = competency.normalize('NFKC').toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
    if (seen.has(key)) throw new Error('Każda kompetencja może wystąpić tylko raz w zadaniu.');
    seen.add(key);
    const below = text(criterion.below, 'Zachowanie poniżej wymagań', 2000);
    const meets = text(criterion.meets, 'Zachowanie zgodne z wymaganiami', 2000);
    const above = text(criterion.above, 'Zachowanie powyżej wymagań', 2000);
    const anchors = [below, meets, above].map((anchor) => anchor.normalize('NFKC').toLocaleLowerCase('pl-PL').replace(/\s+/g, ' '));
    if (new Set(anchors).size !== 3) throw new Error('Opisz różne zachowania dla każdego poziomu oceny.');
    return { competency, below, meets, above };
  });
  return {
    kind: value.kind, title: text(value.title, 'Tytuł', 200),
    instructions: text(value.instructions, 'Instrukcja', 10000),
    expectedOutput: text(value.expectedOutput, 'Oczekiwany rezultat', 4000),
    durationMinutes: value.durationMinutes as number, criteria,
  };
}
