// SC-020-A — konfiguracja marki firmy (white-label). Czyste funkcje: walidacja
// konfiguracji, kontrast WCAG i walidacja plików. Te same reguły egzekwuje baza
// (private.brand_validate_config w 20261109190000_sc020_brand_configuration.sql);
// baza jest ostateczną granicą, ten moduł daje czytelne komunikaty i chroni
// serwowanie plików.
import { whiteLabelEnabled } from './white-label-flag.ts';

export const BRAND_ASSET_BUCKET = 'brand-assets';
export const BRAND_ASSET_KINDS = ['logo', 'favicon'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];
export type BrandMime = 'image/png' | 'image/svg+xml' | 'image/x-icon' | 'image/webp';

/** Limity rozmiaru: logo 512 KB, favicon 128 KB (decyzja techniczna SC-020-A). */
export const BRAND_ASSET_LIMITS: Record<BrandAssetKind, number> = { logo: 512 * 1024, favicon: 128 * 1024 };
const ALLOWED: Record<BrandAssetKind, readonly BrandMime[]> = {
  logo: ['image/png', 'image/svg+xml', 'image/webp'],
  favicon: ['image/png', 'image/svg+xml', 'image/x-icon', 'image/webp'],
};
export const BRAND_MIME_EXTENSION: Record<BrandMime, string> = {
  'image/png': 'png', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/webp': 'webp',
};
/** Największy dopuszczalny wymiar obrazu PNG (px). */
export const BRAND_MAX_DIMENSION = 4096;

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_UI_CONTRAST = 3;

export type BrandColors = { primary: string; onPrimary: string; background: string; text: string; accent: string };
export type BrandConfig = {
  brandName: string;
  colors: BrandColors;
  recruiterPanel: { headerStyle: 'primary' | 'light' };
  candidatePanel: { headline: string; intro: string };
};

export const DEFAULT_BRAND_CONFIG: BrandConfig = {
  brandName: 'Twoja firma',
  colors: { primary: '#1f3a5f', onPrimary: '#ffffff', background: '#ffffff', text: '#1b2433', accent: '#8a4b08' },
  recruiterPanel: { headerStyle: 'primary' },
  candidatePanel: { headline: 'Zadanie rekrutacyjne', intro: '' },
};

export type BrandResult<T> = { ok: true; value: T } | { ok: false; error: string };

const HEX = /^#[0-9a-f]{6}$/;
const COLOR_KEYS = ['accent', 'background', 'onPrimary', 'primary', 'text'] as const;
const COLOR_LABELS: Record<keyof BrandColors, string> = {
  primary: 'kolor główny', onPrimary: 'kolor tekstu na kolorze głównym', background: 'kolor tła',
  text: 'kolor tekstu', accent: 'kolor akcentu',
};
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f<>]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/** Normalizuje kolor do postaci #rrggbb (małe litery). Akceptuje też #rgb. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(raw)) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  return HEX.test(raw) ? raw : null;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
/** Współczynnik kontrastu WCAG 2.x (1–21). */
export function contrastRatio(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export type ContrastCheck = { label: string; ratio: number; minimum: number; ok: boolean };
export function contrastChecks(colors: BrandColors): ContrastCheck[] {
  const check = (label: string, a: string, b: string, minimum: number) => {
    const ratio = contrastRatio(a, b);
    return { label, ratio: Math.round(ratio * 100) / 100, minimum, ok: ratio >= minimum };
  };
  return [
    check('Tekst na tle', colors.text, colors.background, MIN_TEXT_CONTRAST),
    check('Tekst na kolorze głównym', colors.onPrimary, colors.primary, MIN_TEXT_CONTRAST),
    check('Kolor główny na tle (linki, przyciski)', colors.primary, colors.background, MIN_TEXT_CONTRAST),
    check('Akcent na tle', colors.accent, colors.background, MIN_UI_CONTRAST),
  ];
}

function text(value: unknown, label: string, min: number, max: number): BrandResult<string> {
  if (typeof value !== 'string') return { ok: false, error: `${label}: wymagany tekst.` };
  const trimmed = value.trim();
  // Długość w punktach kodowych, jak length() w PostgreSQL (nie w jednostkach UTF-16).
  const length = Array.from(trimmed).length;
  if (length < min || length > max) {
    return { ok: false, error: min === 0 ? `${label}: najwyżej ${max} znaków.` : `${label}: od ${min} do ${max} znaków.` };
  }
  if (FORBIDDEN_TEXT.test(trimmed)) return { ok: false, error: `${label}: niedozwolone znaki (np. < > lub znaki sterujące).` };
  return { ok: true, value: trimmed };
}

/** Waliduje i normalizuje konfigurację marki. Odrzuca nieznane pola. */
export function parseBrandConfig(input: unknown): BrandResult<BrandConfig> {
  if (!isPlainObject(input) || !sameKeys(input, ['brandName', 'colors', 'recruiterPanel', 'candidatePanel'])) {
    return { ok: false, error: 'Nieprawidłowa konfiguracja marki.' };
  }
  const brandName = text(input.brandName, 'Nazwa marki', 1, 80);
  if (!brandName.ok) return brandName;
  if (!isPlainObject(input.colors) || !sameKeys(input.colors, COLOR_KEYS)) return { ok: false, error: 'Nieprawidłowe kolory.' };
  const colors = {} as BrandColors;
  for (const key of COLOR_KEYS) {
    const value = normalizeHex(input.colors[key]);
    if (!value) return { ok: false, error: `Nieprawidłowy ${COLOR_LABELS[key]} — użyj zapisu #RRGGBB.` };
    colors[key] = value;
  }
  const failed = contrastChecks(colors).find(item => !item.ok);
  if (failed) {
    return { ok: false, error: `Za słaby kontrast: ${failed.label} (${failed.ratio}:1, wymagane co najmniej ${failed.minimum}:1).` };
  }
  const recruiter = input.recruiterPanel;
  if (!isPlainObject(recruiter) || !sameKeys(recruiter, ['headerStyle'])
    || (recruiter.headerStyle !== 'primary' && recruiter.headerStyle !== 'light')) {
    return { ok: false, error: 'Nieprawidłowy wygląd panelu rekrutera.' };
  }
  const candidate = input.candidatePanel;
  if (!isPlainObject(candidate) || !sameKeys(candidate, ['headline', 'intro'])) {
    return { ok: false, error: 'Nieprawidłowy wygląd panelu kandydata.' };
  }
  const headline = text(candidate.headline, 'Nagłówek panelu kandydata', 1, 120);
  if (!headline.ok) return headline;
  const intro = text(candidate.intro, 'Wstęp panelu kandydata', 0, 600);
  if (!intro.ok) return intro;
  return { ok: true, value: {
    brandName: brandName.value, colors,
    recruiterPanel: { headerStyle: recruiter.headerStyle },
    candidatePanel: { headline: headline.value, intro: intro.value },
  } };
}

/** Odczyt konfiguracji z formularza edytora. */
export function brandConfigFromForm(form: FormData): BrandResult<BrandConfig> {
  const get = (name: string) => { const v = form.get(name); return typeof v === 'string' ? v : ''; };
  return parseBrandConfig({
    brandName: get('brandName'),
    colors: { primary: get('primary'), onPrimary: get('onPrimary'), background: get('background'), text: get('text'), accent: get('accent') },
    recruiterPanel: { headerStyle: get('headerStyle') },
    candidatePanel: { headline: get('headline'), intro: get('intro') },
  });
}

/** Zmienne CSS z zatwierdzonej konfiguracji (tylko zwalidowane #rrggbb). */
export function brandCssVariables(config: BrandConfig): Record<string, string> {
  const c = config.colors;
  for (const key of COLOR_KEYS) if (!HEX.test(c[key])) throw new Error('Nieprawidłowy kolor marki.');
  return {
    '--brand-primary': c.primary, '--brand-on-primary': c.onPrimary, '--brand-background': c.background,
    '--brand-text': c.text, '--brand-accent': c.accent,
  };
}

// ---------------------------------------------------------------------------
// Pliki marki

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  Array.from(bytes.subarray(offset, offset + length), b => String.fromCharCode(b)).join('');

function sniff(bytes: Uint8Array): BrandMime | 'svg-candidate' | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 22) return 'image/x-icon';
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return 'svg-candidate';
}

function validatePng(bytes: Uint8Array): string | null {
  // IHDR musi być pierwszym blokiem; wymiary w bajtach 16–23.
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== 'IHDR') return 'Uszkodzony plik PNG.';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > BRAND_MAX_DIMENSION || height > BRAND_MAX_DIMENSION) {
    return `Obraz PNG musi mieć wymiary od 1 do ${BRAND_MAX_DIMENSION} px.`;
  }
  return null;
}

function validateWebp(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(4, true) + 8;
  if (declared !== bytes.length) return 'Uszkodzony plik WebP.';
  if (!['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4))) return 'Uszkodzony plik WebP.';
  return null;
}

function validateIco(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (count < 1 || count > 32 || bytes.length < 6 + count * 16) return 'Uszkodzony plik ICO.';
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(6 + i * 16 + 8, true);
    const offset = view.getUint32(6 + i * 16 + 12, true);
    if (!size || offset < 6 + count * 16 || offset + size > bytes.length) return 'Uszkodzony plik ICO.';
  }
  return null;
}

/**
 * SVG jest odrzucany (nie „czyszczony”), jeśli wychodzi poza ścisłą listę
 * dozwolonych. Plik jest skanowany jak XML (z uwzględnieniem cudzysłowów w
 * wartościach atrybutów), a nie wyrażeniami regularnymi na surowym tekście:
 *  - elementy tylko z listy (rysujące, bez aktywnej treści), bez prefiksów;
 *  - atrybuty z prefiksem tylko xmlns:xlink, xlink:href, xml:space, xml:lang;
 *    przestrzenie nazw tylko SVG i xlink; brak atrybutów on*;
 *  - href / xlink:href tylko "#id";
 *  - w CSS (element <style>, atrybut style i każda wartość atrybutu) tylko
 *    funkcje z listy, a url() wyłącznie w postaci url(#id); bez @, \ i /*;
 *  - poprawne komentarze (bez „--” w środku) są pomijane, ale nie w <style>;
 *  - deklaracja XML tylko na początku, w wersji 1.0 i bez kodowania albo z UTF-8;
 *  - bez DOCTYPE/ENTITY, CDATA, innych instrukcji przetwarzania, encji innych niż
 *    &amp; &lt; &gt; &quot; &apos;, znaków sterujących (C0 poza \t\n\r, C1),
 *    U+2028/U+2029/U+FFFE/U+FFFF oraz schematów javascript:/vbscript:/data:;
 *  - nazwy atrybutów tylko z liter ASCII, cyfr i znaków _ . : -.
 */
export function svgProblems(source: string): string[] {
  const problems = new Set<string>();
  const fail = (message: string) => { problems.add(message); };
  let text = source.replace(/^\ufeff/, '');
  // XML 1.0 zabrania tych znaków; ESC jest też potrzebny do przełączania trybu
  // kodowań typu ISO-2022-JP (review #3 #1).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/.test(text)) fail('Znaki sterujące są niedozwolone.');
  // Deklaracja XML tylko bez kodowania albo z UTF-8: parser nie może czytać
  // pliku inaczej niż ten skaner.
  const decl = /^\s*<\?xml\s+version\s*=\s*(["'])1\.0\1(\s+encoding\s*=\s*(["'])utf-8\3)?(\s+standalone\s*=\s*(["'])(yes|no)\5)?\s*\?>/i.exec(text);
  if (decl) text = text.slice(decl[0].length);
  const lower = text.toLowerCase();
  if (/(javascript|vbscript|data)\s*:/.test(lower)) fail('Schematy javascript:, vbscript: i data: są niedozwolone.');
  if (lower.includes('\\')) fail('Znak \\ (ucieczki CSS) jest niedozwolony.');
  if (/&(?!(amp|lt|gt|quot|apos);)/.test(lower)) fail('Encje znakowe są niedozwolone.');

  const stack: string[] = [];
  let sawRoot = false;
  let i = 0;
  const n = lower.length;
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i < n && problems.size === 0) {
    const lt = lower.indexOf('<', i);
    const chunk = lower.slice(i, lt === -1 ? n : lt);
    if (stack.at(-1) === 'style') checkCss(chunk, fail);
    else if (!stack.length && chunk.trim()) fail('Treść poza elementem <svg> jest niedozwolona.');
    if (lt === -1) break;
    i = lt + 1;
    if (lower.startsWith('!--', i) && stack.at(-1) !== 'style') {
      // Zwykły komentarz (np. „Generator: Adobe Illustrator”) jest pomijany,
      // jeśli jest poprawny (bez „--” w środku); w <style> — niedozwolony.
      const end = lower.indexOf('-->', i + 3);
      if (end === -1 || lower.slice(i + 3, end).includes('--')) { fail('Nieprawidłowy komentarz w pliku SVG.'); break; }
      i = end + 3;
      continue;
    }
    if (lower[i] === '!' || lower[i] === '?') {
      fail('DOCTYPE, CDATA i instrukcje przetwarzania są niedozwolone — zapisz plik jako zwykły SVG bez metadanych edytora.');
      break;
    }
    const closing = lower[i] === '/';
    if (closing) i++;
    const nameStart = i;
    while (i < n && !isSpace(lower[i]) && lower[i] !== '>' && lower[i] !== '/') i++;
    const name = lower.slice(nameStart, i);
    if (!SVG_ELEMENTS.has(name)) { fail(`Element <${name.slice(0, 40)}> jest niedozwolony.`); break; }
    if (closing) {
      while (i < n && isSpace(lower[i])) i++;
      if (lower[i] !== '>' || stack.pop() !== name) { fail('Nieprawidłowa struktura pliku SVG.'); break; }
      i++;
      continue;
    }
    if (!sawRoot) { if (name !== 'svg') { fail('Plik nie zaczyna się od elementu <svg>.'); break; } sawRoot = true; }
    else if (!stack.length) { fail('Treść poza elementem <svg> jest niedozwolona.'); break; }
    let selfClosing = false;
    for (;;) {
      while (i < n && isSpace(lower[i])) i++;
      if (lower[i] === '>') { i++; break; }
      if (lower[i] === '/' && lower[i + 1] === '>') { i += 2; selfClosing = true; break; }
      const attrStart = i;
      while (i < n && !isSpace(lower[i]) && !'=/>"\'<'.includes(lower[i])) i++;
      const attr = lower.slice(attrStart, i);
      while (i < n && isSpace(lower[i])) i++;
      if (!/^[a-z_][a-z0-9_.:-]*$/.test(attr) || lower[i] !== '=') { fail('Nieprawidłowy atrybut w pliku SVG.'); break; }
      i++;
      while (i < n && isSpace(lower[i])) i++;
      const quote = lower[i];
      if (quote !== '"' && quote !== "'") { fail('Wartości atrybutów muszą być w cudzysłowie.'); break; }
      const close = lower.indexOf(quote, i + 1);
      if (close === -1) { fail('Nieprawidłowy atrybut w pliku SVG.'); break; }
      checkAttribute(attr, lower.slice(i + 1, close).trim(), fail);
      i = close + 1;
    }
    if (problems.size) break;
    if (!selfClosing) stack.push(name);
  }
  if (!problems.size && (!sawRoot || stack.length)) fail('Nieprawidłowa struktura pliku SVG.');
  return Array.from(problems);
}

function checkAttribute(name: string, value: string, fail: (message: string) => void) {
  if (name.includes(':') && !PREFIXED_ATTRIBUTES.has(name)) return fail(`Atrybut ${name.slice(0, 40)} jest niedozwolony.`);
  if (name.startsWith('on')) return fail('Atrybuty zdarzeń (on…) są niedozwolone.');
  if (value.includes('<')) return fail('Nieprawidłowy atrybut w pliku SVG.');
  if (name === 'xmlns') return value === SVG_NS ? undefined : fail('Dozwolona jest tylko przestrzeń nazw SVG.');
  if (name === 'xmlns:xlink') return value === XLINK_NS ? undefined : fail('Nieprawidłowa przestrzeń nazw xlink.');
  if (name === 'href' || name === 'xlink:href') {
    return /^#[a-z0-9_-]+$/.test(value) ? undefined : fail('Odwołania do zasobów spoza pliku są niedozwolone.');
  }
  checkCss(value, fail);
}

/** CSS lub wartość atrybutu: tylko funkcje z listy, url() wyłącznie url(#id). */
function checkCss(css: string, fail: (message: string) => void) {
  if (/[@\\]|\/\*|<!--|-->/.test(css)) return fail('Reguły @, ucieczki i komentarze w stylach są niedozwolone.');
  const calls = Array.from(css.matchAll(/([a-z0-9_-]*)\s*\(/g));
  for (const call of calls) {
    if (!CSS_FUNCTIONS.has(call[1])) return fail(`Funkcja ${call[1].slice(0, 40) || '()'} w stylach jest niedozwolona.`);
  }
  const urls = calls.filter(call => call[1] === 'url').length;
  const strict = Array.from(css.matchAll(/url\(\s*(['"]?)#[a-z0-9_-]+\1\s*\)/g)).length;
  if (urls !== strict) fail('url() może wskazywać tylko na elementy tego pliku.');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const PREFIXED_ATTRIBUTES = new Set(['xmlns:xlink', 'xlink:href', 'xml:space', 'xml:lang']);
/** Elementy rysujące bez aktywnej treści (porównywane po zamianie na małe litery). */
const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'title', 'desc', 'symbol',
  'style']);
/** Funkcje dozwolone w CSS i wartościach atrybutów (kolory, transformacje, url(#id)). */
const CSS_FUNCTIONS = new Set(['url', 'rgb', 'rgba', 'hsl', 'hsla', 'matrix', 'translate', 'scale', 'rotate', 'skewx', 'skewy']);

function decodeSvg(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type ValidatedAsset = { mime: BrandMime; extension: string; size: number };

/**
 * Waliduje plik marki po zawartości (nie po nazwie ani typie podanym przez
 * przeglądarkę). Używane przed zapisem i przy każdym serwowaniu.
 */
export function validateBrandAsset(bytes: Uint8Array, kind: BrandAssetKind): BrandResult<ValidatedAsset> {
  if (!BRAND_ASSET_KINDS.includes(kind)) return { ok: false, error: 'Nieznany rodzaj pliku.' };
  if (!bytes.length) return { ok: false, error: 'Plik jest pusty.' };
  if (bytes.length > BRAND_ASSET_LIMITS[kind]) {
    return { ok: false, error: `Plik jest za duży (limit ${BRAND_ASSET_LIMITS[kind] / 1024} KB).` };
  }
  let mime = sniff(bytes);
  let problem: string | null = null;
  if (mime === 'svg-candidate') {
    const source = decodeSvg(bytes);
    if (source === null) return { ok: false, error: 'Dozwolone formaty: PNG, SVG, ICO, WebP.' };
    if (!/<svg[\s>]/i.test(source)) return { ok: false, error: 'Dozwolone formaty: PNG, SVG, ICO, WebP.' };
    const problems = svgProblems(source);
    if (problems.length) return { ok: false, error: `Plik SVG odrzucony: ${problems[0]}` };
    mime = 'image/svg+xml';
  } else if (mime === 'image/png') problem = validatePng(bytes);
  else if (mime === 'image/webp') problem = validateWebp(bytes);
  else if (mime === 'image/x-icon') problem = validateIco(bytes);
  if (problem) return { ok: false, error: problem };
  if (!mime || !ALLOWED[kind].includes(mime)) {
    return { ok: false, error: kind === 'logo' ? 'Logo: dozwolone PNG, SVG lub WebP.' : 'Favicon: dozwolone PNG, SVG, ICO lub WebP.' };
  }
  return { ok: true, value: { mime, extension: BRAND_MIME_EXTENSION[mime], size: bytes.length } };
}

/** Ścieżka obiektu w Storage: <company>/<kind>/<uuid>.<ext> (zgodna z polityką RLS). */
export function brandObjectPath(companyId: string, kind: BrandAssetKind, objectId: string, extension: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(companyId) || !uuid.test(objectId) || !BRAND_ASSET_KINDS.includes(kind)
    || !Object.values(BRAND_MIME_EXTENSION).includes(extension)) throw new Error('Nieprawidłowa ścieżka pliku marki.');
  return `${companyId}/${kind}/${objectId}.${extension}`;
}

/** Nagłówki odpowiedzi przy serwowaniu pliku marki. */
export function brandAssetHeaders(mime: BrandMime, size: number): Record<string, string> {
  return {
    'content-type': mime,
    'content-length': String(size),
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'content-disposition': 'inline',
    'referrer-policy': 'no-referrer',
  };
}

/** Czy white-label jest włączony w tym środowisku (domyślnie: tylko Preview/dev).
 * SC-020-D: ta sama decyzja co domeny klienta — lib/white-label-flag.ts. */
export function brandingEnabled(env: Record<string, string | undefined> = process.env) {
  return whiteLabelEnabled(env);
}
