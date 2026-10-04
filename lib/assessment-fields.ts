export const assessmentStatuses = [
  ['pending', 'Oczekuje'], ['in_progress', 'W trakcie'],
  ['completed', 'Zakończony'], ['skipped', 'Pominięty'],
] as const;
export type AssessmentStatus = typeof assessmentStatuses[number][0];

function text(form: FormData, key: string) {
  const value = form.get(key);
  if (value !== null && typeof value !== 'string') throw new Error('Sprawdź dane formularza.');
  return (value ?? '').trim();
}

export function parseAssessmentStage(form: FormData) {
  const name = text(form, 'name'), description = text(form, 'description'), rawSequence = text(form, 'sequence');
  if (!name || name.length > 200) throw new Error('Podaj nazwę etapu (do 200 znaków).');
  if (description.length > 10000) throw new Error('Skróć opis etapu do 10 000 znaków.');
  if (!/^[1-9]\d{0,5}$/.test(rawSequence)) throw new Error('Podaj kolejność od 1 do 999 999, bez ułamków.');
  return { name, description: description || null, sequence: Number(rawSequence) };
}

export function parseAssessmentProgress(form: FormData) {
  const status = text(form, 'status'), notes = text(form, 'notes');
  if (!assessmentStatuses.some(([value]) => value === status)) throw new Error('Wybierz status etapu.');
  if (notes.length > 10000) throw new Error('Skróć notatkę do 10 000 znaków.');
  if (['completed', 'skipped'].includes(status) && !notes) throw new Error('Opisz wykonane zadanie i obserwacje albo powód pominięcia etapu.');
  return { status: status as AssessmentStatus, notes: notes || null };
}
