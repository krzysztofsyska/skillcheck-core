// Only the packages that are actually on sale can arrive from the calculator
// (owner decision 2026-11-02): FREE and PRESELEKCJA. The calculator no longer
// offers paid add-ons, so no extras are parsed.
const packages: Record<string, string> = {
  free: 'FREE', pre: 'PRESELEKCJA',
};

// URL selection is an enquiry only, never a price, entitlement or approval.
export function calculatorSelection(params: Record<string, string | string[] | undefined>): string {
  const { pack, cv, source } = params;
  if (source !== 'calculator-v4' || typeof pack !== 'string' || !Object.hasOwn(packages, pack)
    || typeof cv !== 'string' || !/^\d{2,3}$/.test(cv)) return '';
  const volume = Number(cv);
  if (![10, 20, 30].includes(volume) && !(volume >= 35 && volume <= 150 && volume % 5 === 0)) return '';
  return [
    'Zapytanie z kalkulatora SkillCheck.',
    `Wybrany wariant: ${packages[pack]}. Pula rekrutacji: ${volume} CV.`,
    'Proszę o potwierdzenie dostępności, liczby analiz, zakresu, terminu i sposobu rozliczenia.',
    'To zapytanie, nie zamówienie ani aktywacja usługi. Nie załączam danych kandydatów ani CV.',
  ].join('\n');
}
