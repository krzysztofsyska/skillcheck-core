import type { ScreeningAnalysisVersion, ScreeningCriterionResult, ScreeningReviewOverrideInput, ScreeningResultReview } from './supabase/database.types';

export const ratingLabels = { insufficient_data: 'Brak wystarczających danych', below: 'Poniżej wymagań', meets: 'Spełnia wymagania', above: 'Powyżej wymagań' } as const;
export const statusLabels = { ready: 'Gotowe do analizy', pending: 'Oczekuje na analizę', processing: 'Analiza w toku', completed: 'Analiza ukończona', failed: 'Analiza nie powiodła się', cancelled: 'Analiza anulowana', stale: 'Wynik nieaktualny' } as const;
export const reviewLabels = { approved: 'Zatwierdzono', approved_with_changes: 'Zatwierdzono z korektami', needs_reanalysis: 'Wymaga ponownej analizy' } as const;
export type ScreeningFormState = { error?: string; message?: string; saved?: boolean };
export type ScreeningRoute = { companyId: string; recruitmentId: string; applicationId: string };
export const screeningPath = (r: ScreeningRoute) => `/dashboard/${r.companyId}/recruitments/${r.recruitmentId}/applications/${r.applicationId}/screening`;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function screeningStatus(analysis: Pick<ScreeningAnalysisVersion, 'stale_at' | 'input_fingerprint' | 'execution_status'> | null, fingerprint?: string) {
  if (!analysis) return 'ready';
  if (analysis.stale_at || !fingerprint || analysis.input_fingerprint !== fingerprint) return 'stale';
  return analysis.execution_status;
}

// Parse only the criterion IDs loaded under the user's RLS session. Never accept JSON overrides.
export function readScreeningReview(form: FormData, criteria: ScreeningCriterionResult[], snapshot: string) {
  const disposition = String(form.get('disposition') ?? '') as ScreeningResultReview['disposition'];
  if (!Object.hasOwn(reviewLabels, disposition)) throw new Error('Wybierz sposób zakończenia przeglądu.');
  if (form.get('confirmed') !== 'on') throw new Error('Potwierdź sprawdzenie wyników i cytatów.');
  const note = String(form.get('note') ?? '').trim();
  if (note.length > 10000) throw new Error('Notatka może mieć do 10 000 znaków.');
  const overrides: ScreeningReviewOverrideInput[] = [];
  for (const criterion of criteria) {
    if (form.get(`change:${criterion.id}`) !== 'on') continue;
    const rating = String(form.get(`rating:${criterion.id}`) ?? '') as keyof typeof ratingLabels;
    if (!Object.hasOwn(ratingLabels, rating)) throw new Error('Wybierz prawidłową ocenę.');
    const explanation = String(form.get(`explanation:${criterion.id}`) ?? '').trim();
    if (explanation.length > 4000) throw new Error('Uzasadnienie może mieć do 4000 znaków.');
    const evidence = Array.from({ length: 5 }, (_, i) => String(form.get(`quote:${criterion.id}:${i}`) ?? '')).filter(q => q.trim()).map(quote => {
      const start = snapshot.indexOf(quote);
      if (start < 0 || quote.length > 2000) throw new Error('Każdy cytat musi być dokładnym fragmentem analizowanego CV (do 2000 znaków).');
      return { start, end: start + quote.length, quote };
    });
    if (rating !== 'insufficient_data' && evidence.length === 0) throw new Error('Ocena wymaga cytatu. Przy braku dowodów wybierz „Brak wystarczających danych”.');
    overrides.push({ criterion_result_id: criterion.id, rating_override: rating, evidence_override: evidence, explanation_override: explanation || null });
  }
  if ((disposition === 'approved_with_changes') !== (overrides.length > 0)) throw new Error('Zatwierdzenie z korektami wymaga zaznaczenia co najmniej jednego kryterium. Pozostałe decyzje zapisuj bez korekt.');
  return { disposition, note: note || null, overrides };
}
