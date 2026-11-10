/**
 * SC-020-D — jedna flaga white-label dla marki (SC-020-A) i domen klienta
 * (SC-020-B). Wcześniej obie części czytały WHITE_LABEL_ENABLED inaczej poza
 * Vercelem (np. `next start` bez VERCEL_ENV): marka była wyłączona, a domeny
 * włączone. Teraz obie decyzje są identyczne i domyślnie bezpieczne.
 *
 *  - WHITE_LABEL_ENABLED=true  -> włączone (w każdym środowisku),
 *  - WHITE_LABEL_ENABLED=false -> wyłączone,
 *  - inaczej: włączone tylko na Vercel Preview i w trybie deweloperskim;
 *    produkcja i każde inne środowisko — wyłączone.
 *
 * Produkcja: włączenie to decyzja właściciela (zmienna w Vercel Production).
 */
export type WhiteLabelEnvironment = { readonly [key: string]: string | undefined };

export function whiteLabelEnabled(env: WhiteLabelEnvironment = process.env): boolean {
  const flag = env['WHITE_LABEL_ENABLED'];
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  if (env['VERCEL_ENV'] === 'production') return false;
  return env['VERCEL_ENV'] === 'preview' || env['NODE_ENV'] === 'development';
}
