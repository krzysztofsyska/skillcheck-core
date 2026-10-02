export const behaviorRatings = [
  ['insufficient_data', 'Niewystarczające dane'], ['below', 'Poniżej wymagań'],
  ['meets', 'Zgodne z wymaganiami'], ['above', 'Powyżej wymagań'],
] as const;
export type BehaviorRating = typeof behaviorRatings[number][0];
export const behaviorModuleUnavailable = 'Oceny z historią nie są jeszcze dostępne w tym środowisku. Możesz nadal korzystać z notatek etapów.';
export function behaviorSchemaMissing(code?: string) {
  return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code ?? '');
}
export function behaviorSaveError(code?: string) {
  if (behaviorSchemaMissing(code)) return behaviorModuleUnavailable;
  if (code === 'PT409' || code === '40001') return 'Ocena lub profil stanowiska zmieniły się w innym oknie. Skopiuj swoje uzasadnienie, odśwież stronę i porównaj dane przed ponownym zapisem.';
  if (code === '42501') return 'Nie masz uprawnień do zapisu tej oceny.';
  if (code === '55000') return 'Zgłoszenie, rekrutacja lub stanowisko nie pozwalają już na nowe oceny.';
  if (code === '22023') return 'Sprawdź uzasadnienie i wymagany poziom w profilu stanowiska. Obszar musi mieć jeden poprawny poziom.';
  return 'Nie udało się zapisać oceny. Uzasadnienie pozostało w formularzu. Odśwież dane przed ponowieniem, jeśli zapis mógł się zakończyć.';
}

export function behaviorEditingOpen(applicationStatus: string, recruitmentStatus: string, positionStatus: string) {
  return ['new', 'in_progress'].includes(applicationStatus) && ['draft', 'open'].includes(recruitmentStatus) && ['draft', 'active'].includes(positionStatus);
}

export function parseHistoryBefore(value?: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new Error('Nieprawidłowa strona historii.');
  return Number(value);
}

export function parseBehaviorAssessment(form: FormData) {
  const rating = form.get('rating'), evidence = form.get('evidence');
  if (typeof rating !== 'string' || !behaviorRatings.some(([key]) => key === rating)) throw new Error('Wybierz poziom oceny.');
  if (typeof evidence !== 'string' || evidence.length > 10000) throw new Error('Dowody i wniosek mogą mieć do 10 000 znaków.');
  if (rating !== 'insufficient_data' && !evidence.trim()) throw new Error('Uzasadnij ocenę konkretnym działaniem, kontekstem i rezultatem.');
  return { rating: rating as BehaviorRating, evidence: evidence.trim() };
}
