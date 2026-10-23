const packages: Record<string, string> = {
  free: 'FREE', pre: 'PRESELEKCJA', verify: 'WERYFIKACJA', ac: 'ASSESSMENT CENTER',
};
const extras: Record<string, string> = {
  calls: '5 dodatkowych rozmów AI', tests: 'Testy kompetencji',
  cases: 'Zadanie / case study', consult: 'Konsultacja eksperta',
};

// URL selection is an enquiry only, never a price, entitlement or approval.
export function calculatorSelection(params: Record<string, string | string[] | undefined>): string {
  const { pack, cv, extra, source } = params;
  if (source !== 'calculator-v4' || typeof pack !== 'string' || !Object.hasOwn(packages, pack)
    || typeof cv !== 'string' || !/^\d{2,3}$/.test(cv)) return '';
  const volume = Number(cv);
  if (![10, 20, 30].includes(volume) && !(volume >= 35 && volume <= 150 && volume % 5 === 0)) return '';
  if (extra !== undefined && (typeof extra !== 'string' || extra.length > 100)) return '';
  const keys = typeof extra === 'string' && extra ? extra.split(',') : [];
  if (keys.some(key => !Object.hasOwn(extras, key)) || new Set(keys).size !== keys.length) return '';
  const requested = pack === 'free' ? [] : keys.filter(key =>
    !(key === 'tests' && ['verify', 'ac'].includes(pack))
    && !(['cases', 'consult'].includes(key) && pack === 'ac'));
  return [
    'Zapytanie z kalkulatora SkillCheck v4.',
    `Wybrany wariant: ${packages[pack]}. Pula rekrutacji: ${volume} CV.`,
    `Dodatki do wyceny: ${requested.map(key => extras[key]).join(', ') || 'brak'}.`,
    'Proszę o potwierdzenie dostępności, liczby analiz, zakresu, terminu, ceny i sposobu rozliczenia.',
    'To zapytanie, nie zamówienie ani aktywacja usługi. Nie załączam danych kandydatów ani CV.',
  ].join('\n');
}
