export type ExerciseEditorContext = {
  recruitmentId: string; exerciseId: string; expectedVersion: number;
  positionId: string; positionUpdatedAt: string;
};
export function validExerciseEditorContext(value: ExerciseEditorContext): boolean {
  const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return [value.recruitmentId, value.exerciseId, value.positionId].every(id => typeof id === 'string' && uuid.test(id))
    && Number.isInteger(value.expectedVersion) && value.expectedVersion >= 0 && value.expectedVersion < 2147483647
    && typeof value.positionUpdatedAt === 'string' && Number.isFinite(Date.parse(value.positionUpdatedAt));
}
export function exerciseSaveError(code?: string): string {
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code ?? '')) return 'Zapisywanie zadań nie jest jeszcze dostępne w tym środowisku. Wpisane dane pozostają w formularzu.';
  if (code === 'PT409') return 'Zadanie lub profil stanowiska zmieniły się w innym oknie. Skopiuj swoje zmiany, odśwież stronę i porównaj wersje przed ponownym zapisem.';
  if (code === '42501') return 'Nie masz uprawnień do zapisu tego zadania.';
  if (code === '55000') return 'Rekrutacja lub stanowisko nie pozwalają już na zapis zadań.';
  if (code === '22023') return 'Sprawdź instrukcję, czas zadania i kompletność kryteriów. Opisy poziomów muszą być różne.';
  return 'Nie udało się potwierdzić zapisu. Zachowaj wpisane dane i odśwież historię przed ponowieniem, ponieważ zapis mógł się zakończyć.';
}
